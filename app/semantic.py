"""语义检索（可选特性）：本地嵌入 + 向量相似度搜索。

- 嵌入模型：BGE-small-zh-v1.5（fastembed/ONNX，首次重建索引时联网下载，约 100MB）；
- 存储：账号库 email_vectors 表（float32 BLOB）。优先用 NumPy 批量计算相似度，
  缺少 NumPy 时使用标准库扫描；
  索引最多保留最近 5000 封，且不为运行时引入 sqlite-vec 原生扩展，
  发布门禁与未安装依赖的用户完全不受影响；
- 完全可选：未安装 fastembed，或用户未在偏好设置中启用时，
  助手检索保持现有关键词路径，本模块一律空转。
"""
from __future__ import annotations

from array import array as _farray
from collections import OrderedDict
import importlib.util
import json
import logging
import math
import sqlite3
import threading
import time
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
_inference_lock = threading.Lock()
_search_lock = threading.Lock()
_search_job = None
_search_retry_at = 0.0
_query_cache = OrderedDict()
_QUERY_CACHE_LIMIT = 128
_QUERY_CACHE_SECONDS = 300
_SEARCH_WAIT_SECONDS = 0.4
_update_again: set[str] = set()
_rebuild_pending: set[str] = set()


def _account_values():
    from .account_context import current
    return dict(current.get() or {}, DB_PATH=config.DB_PATH,
                ACCOUNT_ID=getattr(config, 'ACCOUNT_ID', '') or '__default__')


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
        # Importing ONNX on a request/sync thread can itself take seconds.
        return importlib.util.find_spec("fastembed") is not None
    except (ImportError, ValueError):
        return False


def enabled() -> bool:
    """特性开关 = 依赖可用 + 用户在偏好设置中启用。"""
    try:
        prefs = json.loads(db.get_runtime_settings().get("user_preferences", "{}"))
    except (TypeError, json.JSONDecodeError, sqlite3.Error):
        # 极简库（单测）或迁移中的库可能还没有 runtime_settings 表，一律视为未启用。
        return False
    return isinstance(prefs, dict) and prefs.get("semantic_enabled") is True and deps_available()


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
    with _inference_lock:
        return [list(map(float, v)) for v in _embedder().embed(list(texts))]


def _checked_vectors(texts):
    vectors = embed_texts(texts)
    if len(vectors) != len(texts) or any(
        len(v) != _DIM or not all(math.isfinite(x) for x in v) or not _norm(v)
        for v in vectors
    ):
        raise ValueError("语义模型返回了无效向量，请重试")
    return vectors


def _write_batch(batch, vectors, now):
    # Mail can change while inference is running. Never restore an old vector
    # after upsert_email has invalidated it, or after the mail was removed.
    written = 0
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        for (email_id, text), vector in zip(batch, vectors):
            row = c.execute(
                "SELECT subject,from_name,from_addr,to_addr,summary,snippet,"
                "substr(body_text,1,800) AS body_text FROM emails WHERE id=? AND remote_missing=0",
                (email_id,),
            ).fetchone()
            if row is None or _document_text(dict(row)) != text:
                continue
            c.execute(
                "INSERT INTO email_vectors(email_id,embedding,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(email_id) DO UPDATE SET embedding=excluded.embedding,updated_at=excluded.updated_at",
                (email_id, _pack(vector), now),
            )
            written += 1
    return written


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
        c.execute("""CREATE TRIGGER IF NOT EXISTS semantic_text_changed
            AFTER UPDATE OF subject,from_name,from_addr,to_addr,summary,snippet,body_text ON emails
            WHEN OLD.subject IS NOT NEW.subject OR OLD.from_name IS NOT NEW.from_name
              OR OLD.from_addr IS NOT NEW.from_addr OR OLD.to_addr IS NOT NEW.to_addr
              OR OLD.summary IS NOT NEW.summary OR OLD.snippet IS NOT NEW.snippet
              OR OLD.body_text IS NOT NEW.body_text
            BEGIN DELETE FROM email_vectors WHERE email_id=NEW.id; END""")


def _document_text(row: dict) -> str:
    parts = [row.get("subject") or "", row.get("from_name") or row.get("from_addr") or "",
             row.get("to_addr") or "", row.get("summary") or row.get("snippet") or "",
             row.get("body_text") or ""]
    return "\n".join(p for p in parts if p).strip()


def reindex(limit: int = _INDEX_LIMIT, batch_size: int = _BATCH, *, background=False) -> dict:
    with _build_lock:
        return _reindex(max(1, min(limit, _INDEX_LIMIT)), max(1, min(batch_size, _BATCH)), background)


def _reindex(limit: int, batch_size: int, background: bool = False) -> dict:
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
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "model": MODEL_NAME}
            batch = docs[start:start + batch_size]
            vectors = _checked_vectors([text for _id, text in batch])
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "model": MODEL_NAME}
            indexed += _write_batch(batch, vectors, now)
            _set_progress(phase="index", done=min(start + len(batch), total))
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
        return _index_missing(max(1, min(limit, _INDEX_LIMIT)))


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
    indexed = 0
    try:
        for start in range(0, len(docs), _BATCH):
            if not enabled():
                _set_progress(running=False, phase="", done=start)
                return indexed
            batch = docs[start:start + _BATCH]
            vectors = _checked_vectors([value for _, value in batch])
            if not enabled():
                _set_progress(running=False, phase="", done=start)
                return indexed
            indexed += _write_batch(batch, vectors, now)
            _set_progress(phase="index", done=min(start + len(batch), len(docs)))
    except Exception as exc:
        _set_progress(running=False, error=str(exc))
        raise
    _set_progress(running=False, phase="", done=len(docs))
    return indexed


def schedule_missing(rebuild: bool = False) -> None:
    """Catch up in the background after sync or when the user enables search."""
    if not enabled():
        return
    from . import config
    from .account_context import use
    key = config.DB_PATH
    values = _account_values()
    with _update_lock:
        if rebuild:
            _rebuild_pending.add(key)
        if key in _update_pending:
            _update_again.add(key)
            return
        _update_pending.add(key)
        _set_progress(running=True, phase="queued", done=0, total=0, error="")

    def run():
        try:
            while True:
                with _update_lock:
                    full = key in _rebuild_pending
                    _rebuild_pending.discard(key)
                with use(values):
                    if full and enabled():
                        reindex(background=True)
                    else:
                        index_missing()
                    # No missing documents / a disabled preference must also
                    # clear the queued state shown in settings.
                    _set_progress(running=False, phase="")
                with _update_lock:
                    if key in _update_again:
                        _update_again.discard(key)
                        continue
                    _update_pending.discard(key)
                    return
        except Exception:
            log.exception("增量更新语义索引失败")
            with _update_lock:
                _update_pending.discard(key)
                _update_again.discard(key)
                _rebuild_pending.discard(key)
            with use(values):
                _set_progress(running=False, phase="", error="索引更新失败，请稍后重试")

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
        "index_limit": _INDEX_LIMIT,
        "body_char_limit": 800,
        "progress": progress(),
    }


def search(question: str, limit: int = 8, min_score: float = _MIN_SCORE,
           timeout: float = _SEARCH_WAIT_SECONDS) -> list[int]:
    """Bound waiting and work: one daemon search, no queue of stale requests.

    Cache only query embeddings, never mail IDs, so deletions and index changes
    are visible on the next search. A stalled model cannot stall HTTP or exit.
    """
    global _search_job, _search_retry_at
    question = (question or '').strip()[:1000]
    if not question or limit <= 0:
        return []
    key = (config.DB_PATH, question, min(limit, 50), min_score)
    with _search_lock:
        if _search_job is not None:
            if _search_job['key'] != key:
                return []
            job = _search_job
        else:
            if time.monotonic() < _search_retry_at:
                return []
            job = {'key': key, 'done': threading.Event(), 'result': []}
            _search_job = job
            values = _account_values()

            def run():
                global _search_job, _search_retry_at
                try:
                    from .account_context import use
                    with use(values):
                        job['result'] = _search(question, min(limit, 50), min_score)
                except Exception:
                    log.warning('语义检索暂不可用，保留关键词结果', exc_info=True)
                    with _search_lock:
                        _search_retry_at = time.monotonic() + 10
                finally:
                    with _search_lock:
                        _search_job = None
                        job['done'].set()

            threading.Thread(target=run, name='semantic-search', daemon=True).start()
    if not job['done'].wait(max(0, min(timeout, 1.0))):
        return []
    return list(job['result'])


def _search(question: str, limit: int, min_score: float) -> list[int]:
    question = (question or "").strip()
    if not question:
        return []
    _ensure_table()
    with db.conn() as c:
        rows = c.execute("SELECT v.email_id, v.embedding FROM email_vectors v "
                         "JOIN emails e ON e.id=v.email_id WHERE e.remote_missing=0 "
                         "ORDER BY e.date DESC,e.id DESC LIMIT ?", (_INDEX_LIMIT,)).fetchall()
    if not rows:
        return []
    key = (config.DB_PATH, MODEL_NAME, question)
    cached = _query_cache.get(key)
    if cached and time.monotonic() - cached[0] < _QUERY_CACHE_SECONDS:
        query = cached[1]
        _query_cache.move_to_end(key)
    else:
        query = _farray("f", _checked_vectors([question])[0])
        _query_cache[key] = (time.monotonic(), query)
        _query_cache.move_to_end(key)
        while len(_query_cache) > _QUERY_CACHE_LIMIT:
            _query_cache.popitem(last=False)
    scored = _score_rows(rows, query, min_score)
    scored.sort(reverse=True)
    return [email_id for _score, email_id in scored[:limit]]


def _score_rows(rows, query, min_score):
    # NumPy ships with fastembed. einsum uses bounded vector operations without
    # launching a BLAS thread pool. Retain stdlib support for minimal installs.
    try:
        import numpy as np
    except ImportError:
        return _score_rows_python(rows, query, min_score)
    valid = [row for row in rows if isinstance(row['embedding'], bytes)
             and len(row['embedding']) == len(query) * 4]
    if not valid:
        return []
    matrix = np.stack([np.frombuffer(row['embedding'], dtype=np.float32) for row in valid])
    with np.errstate(invalid='ignore', divide='ignore', over='ignore'):
        norms = np.sqrt(np.einsum('ij,ij->i', matrix, matrix, dtype=np.float64)) * _norm(query)
        dots = np.einsum('ij,j->i', matrix, np.asarray(query), dtype=np.float64)
        scores = np.divide(dots, norms, out=np.zeros_like(dots), where=norms != 0)
    return [(float(score), row['email_id']) for row, score in zip(valid, scores)
            if math.isfinite(score) and score >= min_score]


def _score_rows_python(rows, query, min_score):
    query_norm = _norm(query)
    scored = []
    for row in rows:
        try:
            candidate = _unpack(row["embedding"])
        except (ValueError, TypeError):
            continue
        if len(candidate) != len(query) or not all(math.isfinite(v) for v in candidate):
            continue
        score = _cosine(query, candidate, _norm(candidate), query_norm)
        if score >= min_score:
            scored.append((score, row["email_id"]))
    return scored
