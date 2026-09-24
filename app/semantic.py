"""语义检索（可选特性）：本地嵌入 + 向量相似度搜索。

- 嵌入模型：BGE-small-zh-v1.5（fastembed/ONNX，首次重建索引时联网下载，约 100MB）；
- 存储：账号库 email_vectors 表（float32 BLOB）。余弦相似度用纯 stdlib 扫描，
  索引最多保留最近 5000 封，且不为运行时引入 sqlite-vec 原生扩展，
  发布门禁与未安装依赖的用户完全不受影响；
- 完全可选：未安装 fastembed，或用户未在偏好设置中启用时，
  助手检索保持现有关键词路径，本模块一律空转。
"""
from __future__ import annotations

from array import array as _farray
import json
import logging
import math
import sqlite3
import threading
from datetime import datetime

from . import config, db

log = logging.getLogger(__name__)

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
_DIM = 512
_BATCH = 32
_MIN_SCORE = 0.45
_INDEX_LIMIT = 5000

_model = None
_model_lock = threading.Lock()

# 重建索引进度（整体替换字典保证读取端拿到一致快照）。phase: model=下载模型, index=嵌入写入。
_progress_by_db: dict[str, dict] = {}
_progress_lock = threading.Lock()
_update_pending: set[str] = set()
_update_lock = threading.Lock()
_build_lock = threading.Lock()


def _set_progress(**fields) -> None:
    with _progress_lock:
        current = _progress_by_db.get(config.DB_PATH, {})
        _progress_by_db[config.DB_PATH] = {**current, **fields}


def progress() -> dict:
    with _progress_lock:
        return {"running": False, "phase": "", "done": 0, "total": 0, "error": "",
                **_progress_by_db.get(config.DB_PATH, {})}


def deps_available() -> bool:
    """fastembed 是否可导入（嵌入模型首次重建时才联网下载）。"""
    try:
        import fastembed  # noqa: F401
        return True
    except ImportError:
        return False


def enabled() -> bool:
    """特性开关 = 依赖可用 + 用户在偏好设置中启用。"""
    if not deps_available():
        return False
    try:
        prefs = json.loads(db.get_runtime_settings().get("user_preferences", "{}"))
    except (TypeError, json.JSONDecodeError, sqlite3.Error):
        # 极简库（单测）或迁移中的库可能还没有 runtime_settings 表，一律视为未启用。
        return False
    return bool(prefs.get("semantic_enabled"))


def _embedder():
    """惰性加载嵌入模型（首次调用联网下载权重）。测试中可整体替换。"""
    global _model
    with _model_lock:
        if _model is None:
            from fastembed import TextEmbedding
            # Bound ONNX worker threads so background indexing cannot monopolize
            # a laptop while new mail is being synchronized or read.
            _model = TextEmbedding(MODEL_NAME, threads=2)
        return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    return [list(map(float, v)) for v in _embedder().embed(list(texts))]


def _pack(vector: list[float]) -> bytes:
    return _farray("f", vector).tobytes()


def _unpack(blob: bytes) -> _farray:
    values = _farray("f")
    values.frombytes(blob)
    return values


def _cosine(query: _farray, candidate: _farray, candidate_norm: float, query_norm: float) -> float:
    if not candidate_norm or not query_norm:
        return 0.0
    dot = sum(q * c for q, c in zip(query, candidate))
    return dot / (query_norm * candidate_norm)


def _norm(vector) -> float:
    return math.sqrt(sum(v * v for v in vector))


def _ensure_table():
    with db.conn() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS email_vectors("
            "email_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, updated_at TEXT NOT NULL)"
        )


def _document_text(row: dict) -> str:
    parts = [row.get("subject") or "", row.get("from_name") or row.get("from_addr") or "",
             row.get("to_addr") or "", row.get("summary") or row.get("snippet") or "",
             row.get("body_text") or ""]
    return "\n".join(p for p in parts if p).strip()


def reindex(limit: int = _INDEX_LIMIT, batch_size: int = _BATCH) -> dict:
    with _build_lock:
        return _reindex(limit, batch_size)


def _reindex(limit: int, batch_size: int) -> dict:
    """重建最近 N 封邮件的主题、联系人、摘要和有限正文索引。"""
    _ensure_table()
    with db.conn() as c:
        rows = c.execute(
            "SELECT id,subject,from_name,from_addr,to_addr,summary,snippet,"
            "substr(body_text,1,800) AS body_text FROM emails WHERE remote_missing=0 "
            "ORDER BY date DESC,id DESC LIMIT ?", (max(1, min(limit, _INDEX_LIMIT)),),
        ).fetchall()
    docs = [(r["id"], _document_text(dict(r))) for r in rows]
    docs = [(i, t) for i, t in docs if t]
    now = datetime.now().isoformat(timespec="seconds")
    total = len(docs)
    _set_progress(running=True, phase="model", done=0, total=total, error="")
    try:
        indexed = 0
        for start in range(0, total, batch_size):
            batch = docs[start:start + batch_size]
            vectors = embed_texts([text for _id, text in batch])
            with db.conn() as c:
                for (email_id, _text), vector in zip(batch, vectors):
                    c.execute(
                        "INSERT INTO email_vectors(email_id, embedding, updated_at) VALUES(?,?,?) "
                        "ON CONFLICT(email_id) DO UPDATE SET embedding=excluded.embedding, "
                        "updated_at=excluded.updated_at",
                        (email_id, _pack(vector), now),
                    )
            indexed += len(batch)
            _set_progress(phase="index", done=indexed)
    except Exception as exc:
        _set_progress(running=False, error=str(exc))
        raise
    _set_progress(running=False, phase="", done=total)
    with db.conn() as c:
        c.execute("DELETE FROM email_vectors WHERE email_id NOT IN "
                  "(SELECT id FROM emails WHERE remote_missing=0 ORDER BY date DESC,id DESC LIMIT ?)",
                  (max(1, min(limit, _INDEX_LIMIT)),))
    log.info("语义索引重建完成: %d 封邮件", indexed)
    return {"indexed": indexed, "model": MODEL_NAME}


def index_missing(limit: int = _INDEX_LIMIT) -> int:
    with _build_lock:
        return _index_missing(limit)


def _index_missing(limit: int) -> int:
    """Index recent new/changed messages without repeating a full rebuild."""
    if not enabled():
        return 0
    _ensure_table()
    with db.conn() as c:
        # Keep the brute-force cosine scan bounded even after months of syncing.
        c.execute("DELETE FROM email_vectors WHERE email_id NOT IN "
                  "(SELECT id FROM emails WHERE remote_missing=0 ORDER BY date DESC,id DESC LIMIT ?)",
                  (limit,))
        rows = c.execute(
            "SELECT id,subject,from_name,from_addr,to_addr,summary,snippet,"
            "substr(body_text,1,800) AS body_text FROM emails "
            "WHERE remote_missing=0 AND id NOT IN (SELECT email_id FROM email_vectors) "
            "AND id IN (SELECT id FROM emails WHERE remote_missing=0 "
            "ORDER BY date DESC,id DESC LIMIT ?) ORDER BY date DESC,id DESC",
            (limit,),
        ).fetchall()
    docs = [(r["id"], _document_text(dict(r))) for r in rows]
    docs = [(email_id, text) for email_id, text in docs if text]
    if not docs:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    _set_progress(running=True, phase="model", done=0, total=len(docs), error="")
    try:
        for start in range(0, len(docs), _BATCH):
            batch = docs[start:start + _BATCH]
            vectors = embed_texts([value for _, value in batch])
            with db.conn() as c:
                c.executemany(
                    "INSERT INTO email_vectors(email_id,embedding,updated_at) VALUES(?,?,?) "
                    "ON CONFLICT(email_id) DO UPDATE SET embedding=excluded.embedding,updated_at=excluded.updated_at",
                    [(email_id, _pack(vector), now) for (email_id, _), vector in zip(batch, vectors)],
                )
            _set_progress(phase="index", done=min(start + len(batch), len(docs)))
    except Exception as exc:
        _set_progress(running=False, error=str(exc))
        raise
    _set_progress(running=False, phase="", done=len(docs))
    return len(docs)


def schedule_missing() -> None:
    """Catch up in the background after sync or when the user enables search."""
    if not enabled():
        return
    from . import config
    from .account_context import current, use
    key = config.DB_PATH
    values = current.get()
    with _update_lock:
        if key in _update_pending:
            return
        _update_pending.add(key)

    def run():
        try:
            if values is None:
                index_missing()
            else:
                with use(values):
                    index_missing()
        except Exception:
            log.exception("增量更新语义索引失败")
        finally:
            with _update_lock:
                _update_pending.discard(key)

    threading.Thread(target=run, name="semantic-index", daemon=True).start()


def index_stats() -> dict:
    _ensure_table()
    with db.conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM email_vectors").fetchone()
    return {
        "enabled": enabled(),
        "deps_available": deps_available(),
        "indexed": row["n"],
        "last_indexed_at": row["last"] or "",
        "model": MODEL_NAME,
        "progress": progress(),
    }


def search(question: str, limit: int = 8, min_score: float = _MIN_SCORE) -> list[int]:
    """返回与问题语义最接近的邮件 id（按相似度降序）。索引为空时返回 []。"""
    question = (question or "").strip()
    if not question:
        return []
    _ensure_table()
    with db.conn() as c:
        rows = c.execute("SELECT v.email_id, v.embedding FROM email_vectors v "
                         "JOIN emails e ON e.id=v.email_id WHERE e.remote_missing=0").fetchall()
    if not rows:
        return []
    query = _farray("f", embed_texts([question])[0])
    query_norm = _norm(query)
    scored = []
    for row in rows:
        candidate = _unpack(row["embedding"])
        if len(candidate) != len(query):
            continue
        score = _cosine(query, candidate, _norm(candidate), query_norm)
        if score >= min_score:
            scored.append((score, row["email_id"]))
    scored.sort(reverse=True)
    return [email_id for _score, email_id in scored[:limit]]
