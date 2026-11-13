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
import hashlib
import importlib.util
import json
import logging
import math
import re
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
_BODY_CHUNK_SIZE = 900
_BODY_CHUNK_OVERLAP = 100
_MAX_BODY_CHUNKS = 3
_ATT_CHUNK_SIZE = 850
_ATT_CHUNK_OVERLAP = 100
_MAX_ATT_CHUNKS_PER_FILE = 6
_MAX_ATT_FILES_PER_MAIL = 8
_MAX_WARM_ATTACHMENTS_PER_RUN = 24
_THREAD_PEER_LIMIT = 3

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
_update_retry_at: dict[str, float] = {}
_UPDATE_RETRY_SECONDS = 300


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


def _write_chunk_batch(batch, vectors, now) -> set[int]:
    """Persist verified chunk vectors only while source mail & attachment digests match."""
    written_emails: set[int] = set()
    has_att_table = None
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        has_att_table = bool(
            c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_text_index'").fetchone()
        )
        for chunk, vector in zip(batch, vectors):
            email_id = chunk["email_id"]
            mail = c.execute(
                "SELECT status, remote_missing FROM emails WHERE id=?",
                (email_id,),
            ).fetchone()
            if not mail or mail["remote_missing"]:
                continue
            if chunk["chunk_kind"] == "attachment":
                if mail["status"] in ("trash", "spam", "quarantine") or not has_att_table:
                    continue
                att_idx = int(chunk["chunk_index"]) // 100
                att = c.execute(
                    "SELECT digest FROM attachment_text_index WHERE email_id=? AND attachment_index=?",
                    (email_id, att_idx),
                ).fetchone()
                if not att or att["digest"] != chunk["source_digest"]:
                    continue
            c.execute(
                "INSERT INTO semantic_chunks(email_id,chunk_kind,chunk_index,source_ref,source_digest,excerpt,embedding,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(email_id,chunk_kind,chunk_index) DO UPDATE SET "
                "source_ref=excluded.source_ref,source_digest=excluded.source_digest,"
                "excerpt=excluded.excerpt,embedding=excluded.embedding,updated_at=excluded.updated_at",
                (
                    email_id,
                    chunk["chunk_kind"],
                    chunk["chunk_index"],
                    chunk["source_ref"],
                    chunk["source_digest"],
                    chunk["excerpt"],
                    _pack(vector),
                    now,
                ),
            )
            written_emails.add(email_id)
    return written_emails


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
        c.execute(
            "CREATE TABLE IF NOT EXISTS semantic_chunks("
            "email_id INTEGER NOT NULL, chunk_kind TEXT NOT NULL, chunk_index INTEGER NOT NULL, "
            "source_ref TEXT NOT NULL DEFAULT '', source_digest TEXT NOT NULL DEFAULT '', "
            "excerpt TEXT NOT NULL DEFAULT '', embedding BLOB NOT NULL, updated_at TEXT NOT NULL, "
            "PRIMARY KEY(email_id, chunk_kind, chunk_index))"
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_semantic_chunks_email ON semantic_chunks(email_id, chunk_kind)"
        )
        c.execute("""CREATE TRIGGER IF NOT EXISTS semantic_text_changed
            AFTER UPDATE OF subject,from_name,from_addr,to_addr,summary,snippet,body_text ON emails
            WHEN OLD.subject IS NOT NEW.subject OR OLD.from_name IS NOT NEW.from_name
              OR OLD.from_addr IS NOT NEW.from_addr OR OLD.to_addr IS NOT NEW.to_addr
              OR OLD.summary IS NOT NEW.summary OR OLD.snippet IS NOT NEW.snippet
              OR OLD.body_text IS NOT NEW.body_text
            BEGIN
              DELETE FROM email_vectors WHERE email_id=NEW.id;
              DELETE FROM semantic_chunks WHERE email_id=NEW.id;
            END""")
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").fetchone():
            c.execute("""CREATE TRIGGER IF NOT EXISTS semantic_thread_summary_changed
                AFTER UPDATE OF summary ON threads
                WHEN OLD.summary IS NOT NEW.summary
                BEGIN
                  DELETE FROM semantic_chunks
                  WHERE chunk_kind='thread' AND email_id IN (SELECT id FROM emails WHERE thread_id=NEW.thread_id);
                END""")


def _document_text(row: dict) -> str:
    parts = [row.get("subject") or "", row.get("from_name") or row.get("from_addr") or "",
             row.get("to_addr") or "", row.get("summary") or row.get("snippet") or "",
             row.get("body_text") or ""]
    return "\n".join(p for p in parts if p).strip()


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _slice_text(text: str, size: int, overlap: int, limit: int) -> list[str]:
    text = str(text or "").strip()
    if not text:
        return []
    step = max(1, size - overlap)
    slices = []
    pos = 0
    while pos < len(text) and len(slices) < limit:
        chunk = text[pos:pos + size].strip()
        if chunk:
            slices.append(chunk)
        if pos + size >= len(text):
            break
        pos += step
    return slices


def _compact_excerpt(value: str, limit: int = 240) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
    return cleaned[:limit] + ("…" if len(cleaned) > limit else "")


def _thread_chunk_doc(c, row: dict) -> dict | None:
    """Build one semantic chunk capturing the historical conversation context of a thread."""
    thread_id = str(row.get("thread_id") or "").strip()
    if not thread_id or row.get("status") in ("trash", "spam", "quarantine"):
        return None
    has_threads = bool(c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").fetchone())
    thread_row = c.execute("SELECT summary FROM threads WHERE thread_id=?", (thread_id,)).fetchone() if has_threads else None
    summary = str((thread_row["summary"] if thread_row else "") or "").strip()
    peers = c.execute(
        "SELECT id, subject, from_name, from_addr, date, snippet, substr(body_text,1,240) AS body_head "
        "FROM emails WHERE thread_id=? AND id<>? AND remote_missing=0 "
        "AND status NOT IN ('trash','spam','quarantine') ORDER BY date DESC, id DESC LIMIT ?",
        (thread_id, row["id"], _THREAD_PEER_LIMIT),
    ).fetchall()
    if not summary and not peers:
        return None
    lines = []
    if row.get("subject"):
        lines.append(f"邮件主题：{str(row['subject'])[:180]}")
    if summary:
        lines.append(f"历史会话概要：{summary[:420]}")
    for peer in reversed(peers):
        who = str(peer["from_name"] or peer["from_addr"] or "").strip()[:60]
        body_hint = re.sub(r"\s+", " ", str(peer["snippet"] or peer["body_head"] or "")).strip()[:140]
        lines.append(f"往来：[{str(peer['date'] or '')[:10]}] {who} · {str(peer['subject'] or '')[:100]} | {body_hint}")
    text = "\n".join(lines).strip()
    if not text:
        return None
    preview = summary or " / ".join(
        f"{str(p['from_name'] or p['from_addr'] or '')[:24]}: {re.sub(r'\\s+', ' ', str(p['snippet'] or p['body_head'] or '')).strip()[:90]}"
        for p in reversed(peers)
    )
    return {
        "email_id": row["id"],
        "chunk_kind": "thread",
        "chunk_index": 0,
        "source_ref": str(row.get("subject") or "")[:180],
        "source_digest": _text_digest(text),
        "excerpt": _compact_excerpt(preview),
        "text": text,
    }


def _body_chunk_docs(row: dict) -> list[dict]:
    """Chunk body content beyond the primary 800-char embedding window."""
    full_body = str(row.get("full_body_text") or "")
    if len(full_body) <= 800:
        return []
    subject = str(row.get("subject") or "").strip()[:180]
    docs = []
    for idx, piece in enumerate(_slice_text(full_body[750:], _BODY_CHUNK_SIZE, _BODY_CHUNK_OVERLAP, _MAX_BODY_CHUNKS)):
        text = f"邮件：{subject}\n正文续篇：{piece}" if subject else piece
        docs.append({
            "email_id": row["id"],
            "chunk_kind": "body",
            "chunk_index": idx,
            "source_ref": subject,
            "source_digest": _text_digest(text),
            "excerpt": _compact_excerpt(piece),
            "text": text,
        })
    return docs


def _attachment_chunk_docs(c, row: dict) -> list[dict]:
    """Build bounded semantic chunks from cached extracted attachment text."""
    if row.get("status") in ("trash", "spam", "quarantine"):
        return []
    if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_text_index'").fetchone():
        return []
    att_rows = c.execute(
        "SELECT attachment_index, digest, name, body FROM attachment_text_index "
        "WHERE email_id=? ORDER BY attachment_index LIMIT ?",
        (row["id"], _MAX_ATT_FILES_PER_MAIL),
    ).fetchall()
    if not att_rows:
        return []
    subject = str(row.get("subject") or "").strip()[:180]
    docs = []
    for att in att_rows:
        att_index = int(att["attachment_index"])
        name = str(att["name"] or "未命名附件")[:180]
        slices = _slice_text(att["body"] or "", _ATT_CHUNK_SIZE, _ATT_CHUNK_OVERLAP, _MAX_ATT_CHUNKS_PER_FILE)
        for slice_idx, piece in enumerate(slices):
            text = f"附件：{name}\n来源邮件：{subject}\n{piece}" if subject else f"附件：{name}\n{piece}"
            docs.append({
                "email_id": row["id"],
                "chunk_kind": "attachment",
                "chunk_index": att_index * 100 + slice_idx,
                "source_ref": name,
                "source_digest": str(att["digest"] or ""),
                "excerpt": _compact_excerpt(piece),
                "text": text,
            })
    return docs


def _build_email_chunks(c, row: dict) -> list[dict]:
    chunks = []
    if thread_doc := _thread_chunk_doc(c, row):
        chunks.append(thread_doc)
    chunks.extend(_body_chunk_docs(row))
    chunks.extend(_attachment_chunk_docs(c, row))
    return chunks


def _warm_recent_attachments(rows: list[dict], *, max_files: int = _MAX_WARM_ATTACHMENTS_PER_RUN) -> None:
    """Warm local attachment text cache for eligible recent messages before chunk embedding."""
    if max_files <= 0:
        return
    try:
        from . import attachment_text
    except ImportError:
        return
    remaining = max_files
    for row in rows:
        if remaining <= 0:
            break
        if row.get("status") in ("trash", "spam", "quarantine"):
            continue
        raw_att = row.get("attachments")
        if not raw_att or raw_att in ("[]", "null"):
            continue
        if not row.get("raw_path"):
            continue
        remaining -= attachment_text.warm_email_attachments(row["id"], max_files=min(4, remaining))


_EMAIL_SELECT = (
    "SELECT id,subject,from_name,from_addr,to_addr,summary,snippet,"
    "substr(body_text,1,800) AS body_text,body_text AS full_body_text,"
    "thread_id,status,attachments,raw_path FROM emails "
)


def _prune_vectors(c, limit: int) -> None:
    subquery = "(SELECT id FROM emails WHERE remote_missing=0 ORDER BY date DESC,id DESC LIMIT ?)"
    c.execute(f"DELETE FROM email_vectors WHERE email_id NOT IN {subquery}", (limit,))
    c.execute(f"DELETE FROM semantic_chunks WHERE email_id NOT IN {subquery}", (limit,))


def _pending_chunks_for_rows(c, rows: list[dict], *, replace_all: bool) -> tuple[list[dict], list[tuple[int, str, int]]]:
    """Return missing/outdated semantic chunks plus stale chunk keys to remove."""
    if not rows:
        return [], []
    row_ids = [r["id"] for r in rows]
    existing_map: dict[tuple[int, str, int], str] = {}
    if not replace_all:
        marks = ",".join("?" for _ in row_ids)
        for existing in c.execute(
            f"SELECT email_id, chunk_kind, chunk_index, source_digest FROM semantic_chunks WHERE email_id IN ({marks})",
            row_ids,
        ).fetchall():
            existing_map[(existing["email_id"], existing["chunk_kind"], existing["chunk_index"])] = existing["source_digest"]
    to_embed: list[dict] = []
    expected_keys_by_email: dict[int, set[tuple[str, int]]] = {}
    for row in rows:
        built = _build_email_chunks(c, row)
        expected_keys_by_email[row["id"]] = {(item["chunk_kind"], item["chunk_index"]) for item in built}
        for item in built:
            key = (item["email_id"], item["chunk_kind"], item["chunk_index"])
            if replace_all or existing_map.get(key) != item["source_digest"]:
                to_embed.append(item)
    stale: list[tuple[int, str, int]] = []
    if not replace_all:
        for (email_id, kind, idx) in existing_map:
            if (kind, idx) not in expected_keys_by_email.get(email_id, set()):
                stale.append((email_id, kind, idx))
    return to_embed, stale


def reindex(limit: int = _INDEX_LIMIT, batch_size: int = _BATCH, *, background=False, warm_attachments: bool = True) -> dict:
    with _build_lock:
        return _reindex(max(1, min(limit, _INDEX_LIMIT)), max(1, min(batch_size, _BATCH)), background, warm_attachments=warm_attachments)


def _reindex(limit: int, batch_size: int, background: bool = False, *, warm_attachments: bool = True) -> dict:
    """重建最近 N 封邮件（含正文续篇、历史会话脉络及已提取附件切片）的本地语义索引。"""
    _ensure_table()
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            f"{_EMAIL_SELECT} WHERE remote_missing=0 ORDER BY date DESC,id DESC LIMIT ?",
            (max(1, min(limit, _INDEX_LIMIT)),),
        ).fetchall()]
    if warm_attachments:
        _warm_recent_attachments(rows)
    with db.conn() as c:
        c.execute("DELETE FROM semantic_chunks")
        chunks, _ = _pending_chunks_for_rows(c, rows, replace_all=True)
    docs = [(r["id"], _document_text(r)) for r in rows]
    docs = [(i, t) for i, t in docs if t]
    now = datetime.now().isoformat(timespec="seconds")
    total = len(docs) + len(chunks)
    done = 0
    _set_progress(running=True, phase="model", done=0, total=total, error="")
    try:
        indexed = 0
        chunks_written = 0
        for start in range(0, len(docs), batch_size):
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "chunks": chunks_written, "model": MODEL_NAME}
            batch = docs[start:start + batch_size]
            vectors = _checked_vectors([text for _id, text in batch])
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "chunks": chunks_written, "model": MODEL_NAME}
            indexed += _write_batch(batch, vectors, now)
            done += len(batch)
            _set_progress(phase="index", done=done)
        for start in range(0, len(chunks), batch_size):
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "chunks": chunks_written, "model": MODEL_NAME}
            batch = chunks[start:start + batch_size]
            vectors = _checked_vectors([item["text"] for item in batch])
            if background and not enabled():
                _set_progress(running=False, phase="")
                return {"indexed": indexed, "chunks": chunks_written, "model": MODEL_NAME}
            _write_chunk_batch(batch, vectors, now)
            chunks_written += len(batch)
            done += len(batch)
            _set_progress(phase="index", done=done)
    except Exception as exc:
        _set_progress(running=False, error=str(exc))
        raise
    _set_progress(running=False, phase="", done=total)
    with db.conn() as c:
        _prune_vectors(c, max(1, min(limit, _INDEX_LIMIT)))
    log.info("语义索引重建完成: %d 封邮件, %d 个扩展切片", indexed, chunks_written)
    return {"indexed": indexed, "chunks": chunks_written, "model": MODEL_NAME}


def index_missing(limit: int = _INDEX_LIMIT, *, warm_attachments: bool = True) -> int:
    with _build_lock:
        return _index_missing(max(1, min(limit, _INDEX_LIMIT)), warm_attachments=warm_attachments)


def _index_missing(limit: int, *, warm_attachments: bool = True) -> int:
    """Index recent new/changed messages and updated attachment/thread chunks without full rebuild."""
    if not enabled():
        return 0
    _ensure_table()
    with db.conn() as c:
        # Keep the brute-force cosine scan bounded even after months of syncing.
        _prune_vectors(c, limit)
        recent_rows = [dict(r) for r in c.execute(
            f"{_EMAIL_SELECT} WHERE remote_missing=0 ORDER BY date DESC,id DESC LIMIT ?",
            (limit,),
        ).fetchall()]
    if warm_attachments:
        _warm_recent_attachments(recent_rows)
    with db.conn() as c:
        existing_primary = {r["email_id"] for r in c.execute("SELECT email_id FROM email_vectors").fetchall()}
        missing_rows = [r for r in recent_rows if r["id"] not in existing_primary]
        chunks, stale_chunks = _pending_chunks_for_rows(c, recent_rows, replace_all=False)
        for email_id, kind, idx in stale_chunks:
            c.execute(
                "DELETE FROM semantic_chunks WHERE email_id=? AND chunk_kind=? AND chunk_index=?",
                (email_id, kind, idx),
            )
    docs = [(r["id"], _document_text(r)) for r in missing_rows]
    docs = [(email_id, text) for email_id, text in docs if text]
    if not docs and not chunks:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    total = len(docs) + len(chunks)
    done = 0
    _set_progress(running=True, phase="model", done=0, total=total, error="")
    written_primary = 0
    chunk_emails: set[int] = set()
    try:
        for start in range(0, len(docs), _BATCH):
            if not enabled():
                _set_progress(running=False, phase="", done=done)
                return written_primary or len(chunk_emails)
            batch = docs[start:start + _BATCH]
            vectors = _checked_vectors([value for _, value in batch])
            if not enabled():
                _set_progress(running=False, phase="", done=done)
                return written_primary or len(chunk_emails)
            written_primary += _write_batch(batch, vectors, now)
            done += len(batch)
            _set_progress(phase="index", done=done)
        for start in range(0, len(chunks), _BATCH):
            if not enabled():
                _set_progress(running=False, phase="", done=done)
                return written_primary or len(chunk_emails)
            batch = chunks[start:start + _BATCH]
            vectors = _checked_vectors([item["text"] for item in batch])
            if not enabled():
                _set_progress(running=False, phase="", done=done)
                return written_primary or len(chunk_emails)
            chunk_emails.update(_write_chunk_batch(batch, vectors, now))
            done += len(batch)
            _set_progress(phase="index", done=done)
    except Exception as exc:
        _set_progress(running=False, error=str(exc))
        raise
    _set_progress(running=False, phase="", done=total)
    return written_primary if docs else len(chunk_emails)


def schedule_missing(rebuild: bool = False) -> None:
    """Catch up in the background after sync or when the user enables search."""
    if not enabled():
        return
    from . import config
    from .account_context import use
    key = config.DB_PATH
    values = _account_values()
    with _update_lock:
        if not rebuild and time.monotonic() < _update_retry_at.get(key, 0):
            return  # Keep the error visible; new mail cannot hammer model downloads.
        if rebuild:
            _update_retry_at.pop(key, None)
            _rebuild_pending.add(key)
        if key in _update_pending:
            _update_again.add(key)
            return
        _update_pending.add(key)
        _set_progress(running=True, phase="queued", done=0, total=0, error="")

    def run():
        from .energy_scheduler import background_priority
        background_priority()
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
                    _update_retry_at.pop(key, None)
                    if key in _update_again:
                        _update_again.discard(key)
                        continue
                    _update_pending.discard(key)
                    return
        except Exception:
            log.exception("增量更新语义索引失败")
            with _update_lock:
                _update_retry_at[key] = time.monotonic() + _UPDATE_RETRY_SECONDS
                _update_pending.discard(key)
                _update_again.discard(key)
                _rebuild_pending.discard(key)
            with use(values):
                _set_progress(running=False, phase="", error="索引更新失败，请稍后重试")

    from .account_guard import start_account_thread
    try:
        start_account_thread(run, name="semantic-index")
    except BaseException:
        with _update_lock:
            _update_retry_at[key] = time.monotonic() + _UPDATE_RETRY_SECONDS
            _update_pending.discard(key)
            _update_again.discard(key)
            _rebuild_pending.discard(key)
        _set_progress(running=False, phase="", error="索引更新失败，请稍后重试")
        raise


def index_stats() -> dict:
    _ensure_table()
    with db.conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM email_vectors").fetchone()
        chunk_row = c.execute(
            "SELECT COUNT(*) AS total, "
            "COALESCE(SUM(CASE WHEN chunk_kind='attachment' THEN 1 ELSE 0 END), 0) AS att_chunks, "
            "COALESCE(SUM(CASE WHEN chunk_kind='thread' THEN 1 ELSE 0 END), 0) AS thread_chunks, "
            "COALESCE(SUM(CASE WHEN chunk_kind='body' THEN 1 ELSE 0 END), 0) AS body_chunks, "
            "COUNT(DISTINCT CASE WHEN chunk_kind='attachment' THEN (email_id || ':' || (chunk_index / 100)) END) AS att_files "
            "FROM semantic_chunks"
        ).fetchone()
    return {
        "enabled": enabled(),
        "deps_available": deps_available(),
        "indexed": row["n"],
        "chunk_count": int(chunk_row["total"] or 0),
        "attachment_chunks": int(chunk_row["att_chunks"] or 0),
        "attachment_files": int(chunk_row["att_files"] or 0),
        "thread_chunks": int(chunk_row["thread_chunks"] or 0),
        "body_chunks": int(chunk_row["body_chunks"] or 0),
        "last_indexed_at": row["last"] or "",
        "model": MODEL_NAME,
        "index_limit": _INDEX_LIMIT,
        "body_char_limit": 800,
        "progress": progress(),
    }


_recent_hits: OrderedDict[tuple[str, str], dict[int, dict]] = OrderedDict()
_RECENT_HITS_LIMIT = 32


def _remember_hits(db_path: str, question: str, hits: list[dict]) -> None:
    if not hits:
        return
    key = (db_path, question)
    with _search_lock:
        _recent_hits[key] = {h["email_id"]: h for h in hits}
        _recent_hits.move_to_end(key)
        while len(_recent_hits) > _RECENT_HITS_LIMIT:
            _recent_hits.popitem(last=False)


def hit_details(question: str, email_ids=None) -> dict[int, dict]:
    """Return attribution metadata for IDs matched in the latest semantic search call."""
    key = (config.DB_PATH, (question or "").strip()[:1000])
    with _search_lock:
        mapping = dict(_recent_hits.get(key) or {})
    if email_ids is None:
        return mapping
    wanted = set(email_ids)
    return {eid: info for eid, info in mapping.items() if eid in wanted}


def _run_search(question: str, limit: int = 8, min_score: float = _MIN_SCORE,
                timeout: float = _SEARCH_WAIT_SECONDS) -> list[dict]:
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
            job = {'key': key, 'done': threading.Event(), 'result': [], 'hits': []}
            _search_job = job
            values = _account_values()

            def run():
                global _search_job, _search_retry_at
                try:
                    from .account_context import use
                    with use(values):
                        hits = _search_hits(question, min(limit, 50), min_score)
                        _remember_hits(values.get("DB_PATH") or config.DB_PATH, question, hits)
                        job['hits'] = hits
                        job['result'] = [hit['email_id'] for hit in hits]
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
    return list(job['hits'])


def search_hits(question: str, limit: int = 8, min_score: float = _MIN_SCORE,
                timeout: float = _SEARCH_WAIT_SECONDS) -> list[dict]:
    """Return top matching email hits with source metadata ('email'|'thread'|'body'|'attachment')."""
    return _run_search(question, limit=limit, min_score=min_score, timeout=timeout)


def search(question: str, limit: int = 8, min_score: float = _MIN_SCORE,
           timeout: float = _SEARCH_WAIT_SECONDS) -> list[int]:
    """Return matching email IDs ordered by descending semantic similarity."""
    return [hit["email_id"] for hit in _run_search(question, limit=limit, min_score=min_score, timeout=timeout)]


def _query_embedding(question: str) -> _farray:
    key = (config.DB_PATH, MODEL_NAME, question)
    cached = _query_cache.get(key)
    if cached and time.monotonic() - cached[0] < _QUERY_CACHE_SECONDS:
        _query_cache.move_to_end(key)
        return cached[1]
    query = _farray("f", _checked_vectors([question])[0])
    _query_cache[key] = (time.monotonic(), query)
    _query_cache.move_to_end(key)
    while len(_query_cache) > _QUERY_CACHE_LIMIT:
        _query_cache.popitem(last=False)
    return query


def _search_hits(question: str, limit: int, min_score: float) -> list[dict]:
    question = (question or "").strip()
    if not question:
        return []
    _ensure_table()
    with db.conn() as c:
        rows = c.execute(
            "SELECT v.email_id, v.embedding FROM email_vectors v "
            "JOIN emails e ON e.id=v.email_id WHERE e.remote_missing=0 "
            "ORDER BY e.date DESC,e.id DESC LIMIT ?",
            (_INDEX_LIMIT,),
        ).fetchall()
        chunk_rows = c.execute(
            "SELECT sc.email_id, sc.chunk_kind, sc.source_ref, sc.excerpt, sc.embedding "
            "FROM semantic_chunks sc JOIN emails e ON e.id=sc.email_id "
            "WHERE e.remote_missing=0 AND e.status NOT IN ('trash','spam','quarantine') "
            "ORDER BY e.date DESC,e.id DESC LIMIT ?",
            (_INDEX_LIMIT * 6,),
        ).fetchall()
    if not rows and not chunk_rows:
        return []
    query = _query_embedding(question)
    best_by_email: dict[int, dict] = {}
    for score, email_id in _score_rows(rows, query, min_score):
        prev = best_by_email.get(email_id)
        if not prev or score > prev["score"]:
            best_by_email[email_id] = {
                "email_id": email_id,
                "score": score,
                "match_kind": "email",
                "source_ref": "",
                "excerpt": "",
            }
    for score, idx in _score_row_indices(chunk_rows, query, min_score):
        row = chunk_rows[idx]
        email_id = row["email_id"]
        prev = best_by_email.get(email_id)
        # Prefer richer attachment/thread explanation when cosine similarity ties closely.
        if not prev or score > prev["score"] + 1e-6 or (abs(score - prev["score"]) <= 0.02 and row["chunk_kind"] in ("attachment", "thread")):
            best_by_email[email_id] = {
                "email_id": email_id,
                "score": max(score, prev["score"]) if prev else score,
                "match_kind": row["chunk_kind"],
                "source_ref": row["source_ref"] or "",
                "excerpt": row["excerpt"] or "",
            }
    ranked = sorted(best_by_email.values(), key=lambda item: (item["score"], item["email_id"]), reverse=True)
    return ranked[:limit]


def _search(question: str, limit: int, min_score: float) -> list[int]:
    return [hit["email_id"] for hit in _search_hits(question, limit, min_score)]


def _score_row_indices(rows, query, min_score) -> list[tuple[float, int]]:
    if not rows:
        return []
    try:
        import numpy as np
    except ImportError:
        return _score_row_indices_python(rows, query, min_score)
    indexed_valid = [(idx, row) for idx, row in enumerate(rows)
                     if isinstance(row['embedding'], bytes) and len(row['embedding']) == len(query) * 4]
    if not indexed_valid:
        return []
    matrix = np.stack([np.frombuffer(row['embedding'], dtype=np.float32) for _idx, row in indexed_valid])
    with np.errstate(invalid='ignore', divide='ignore', over='ignore'):
        norms = np.sqrt(np.einsum('ij,ij->i', matrix, matrix, dtype=np.float64)) * _norm(query)
        dots = np.einsum('ij,j->i', matrix, np.asarray(query), dtype=np.float64)
        scores = np.divide(dots, norms, out=np.zeros_like(dots), where=norms != 0)
    return [(float(score), idx) for (idx, _row), score in zip(indexed_valid, scores)
            if math.isfinite(score) and score >= min_score]


def _score_row_indices_python(rows, query, min_score) -> list[tuple[float, int]]:
    query_norm = _norm(query)
    scored = []
    for idx, row in enumerate(rows):
        try:
            candidate = _unpack(row["embedding"])
        except (ValueError, TypeError):
            continue
        if len(candidate) != len(query) or not all(math.isfinite(v) for v in candidate):
            continue
        score = _cosine(query, candidate, _norm(candidate), query_norm)
        if score >= min_score:
            scored.append((score, idx))
    return scored


def _score_rows(rows, query, min_score):
    # NumPy ships with fastembed. einsum uses bounded vector operations without
    # launching a BLAS thread pool. Retain stdlib support for minimal installs.
    return [(score, rows[idx]['email_id']) for score, idx in _score_row_indices(rows, query, min_score)]
