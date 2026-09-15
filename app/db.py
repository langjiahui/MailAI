"""SQLite 存储层。每次操作独立连接，线程安全。"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from email.utils import getaddresses

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS mailbox_sequence (id INTEGER PRIMARY KEY, value INTEGER DEFAULT 0);
INSERT OR IGNORE INTO mailbox_sequence VALUES(1,0);
CREATE TABLE IF NOT EXISTS outbox (
    token TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
    due_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    result TEXT DEFAULT '{}', error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS undo_operations (
    token TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid INTEGER NOT NULL,
    folder TEXT NOT NULL DEFAULT 'INBOX',
    message_id TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    thread_id TEXT,
    thread_summary TEXT,
    sender_profile_id INTEGER,
    subject TEXT,
    from_addr TEXT,
    from_name TEXT,
    to_addr TEXT,
    recipient_names TEXT DEFAULT '{}',
    date TEXT,
    snippet TEXT,
    body_text TEXT,
    body_html TEXT,
    urls TEXT DEFAULT '[]',
    attachments TEXT DEFAULT '[]',
    attachment_analysis TEXT DEFAULT '[]',
    auth TEXT DEFAULT '{}',
    score INTEGER DEFAULT 0,
    verdict TEXT DEFAULT 'clean',          -- clean / suspicious / phishing
    findings TEXT DEFAULT '[]',            -- 规则命中的证据
    spam_score INTEGER DEFAULT 0,
    category TEXT,                         -- LLM 分类
    priority TEXT,                         -- 高/中/低
    summary TEXT,
    llm_phishing INTEGER,                  -- LLM 复核结论 0/1
    llm_reasons TEXT DEFAULT '[]',
    status TEXT DEFAULT 'inbox',           -- inbox / quarantine / spam
    reviewed INTEGER DEFAULT 0,
    feedback TEXT,                         -- fp 误报 / fn 漏报
    feedback_note TEXT,
    url_chain TEXT DEFAULT '[]',           -- URL 跳转链
    final_landing_domain TEXT,
    final_landing_ip TEXT,
    review_source TEXT,                    -- rule / llm / feedback_adjust
    recommended_status TEXT DEFAULT 'inbox', -- 检测建议 inbox / quarantine / spam
    action_mode TEXT DEFAULT 'auto',       -- observe / review / auto
    action_taken INTEGER DEFAULT 0,
    action_reason TEXT,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    is_favorite INTEGER DEFAULT 0,
    is_local_archive INTEGER DEFAULT 0,
    cleanup_hold TEXT DEFAULT '',
    imap_flags TEXT DEFAULT '[]',
    remote_missing INTEGER DEFAULT 0,
    pending_action TEXT DEFAULT '',
    pending_target TEXT DEFAULT '',
    pending_target_uid INTEGER,
    pending_due_at TEXT,
    pending_attempts INTEGER DEFAULT 0,
    pending_error TEXT DEFAULT '',
    raw_path TEXT,
    processing_complete INTEGER DEFAULT 1,
    created_at TEXT,
    UNIQUE(folder, uid)
);
CREATE TABLE IF NOT EXISTS seen_sync_jobs (
    email_id INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    desired_value INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL,
    last_error TEXT DEFAULT '',
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_sync_jobs_due ON seen_sync_jobs(due_at);
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER REFERENCES emails(id),
    title TEXT NOT NULL,
    deadline TEXT,
    status TEXT DEFAULT 'open',            -- open / done
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_status_id ON todos(status,id DESC);
CREATE INDEX IF NOT EXISTS idx_todos_email ON todos(email_id);
CREATE INDEX IF NOT EXISTS idx_emails_visible_date ON emails(remote_missing,date DESC,id DESC);
CREATE TABLE IF NOT EXISTS sync_state (
    folder TEXT PRIMARY KEY,
    last_uid INTEGER DEFAULT 0,
    uid_validity INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_jobs (
    job_key TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total INTEGER DEFAULT 0,
    processed INTEGER DEFAULT 0,
    message TEXT DEFAULT '',
    error TEXT DEFAULT '',
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT UNIQUE NOT NULL,
    message_ids TEXT DEFAULT '[]',
    participant_domains TEXT DEFAULT '[]',
    summary TEXT,
    last_email_id INTEGER REFERENCES emails(id),
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sender_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_key TEXT UNIQUE NOT NULL,
    from_domain TEXT,
    first_seen TEXT,
    last_seen TEXT,
    message_count INTEGER DEFAULT 0,
    internal_count INTEGER DEFAULT 0,
    external_count INTEGER DEFAULT 0,
    hour_histogram TEXT DEFAULT '{}',
    attachment_names TEXT DEFAULT '[]',
    attachment_types TEXT DEFAULT '[]',
    typical_categories TEXT DEFAULT '[]',
    avg_body_length INTEGER DEFAULT 0,
    linguistic_signature TEXT DEFAULT '{}',
    risk_score INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER REFERENCES emails(id),
    action TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    actor TEXT DEFAULT 'system',
    reason TEXT,
    meta TEXT DEFAULT '{}',
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS url_chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER REFERENCES emails(id),
    original_url TEXT NOT NULL,
    chain TEXT DEFAULT '[]',
    final_url TEXT,
    final_domain TEXT,
    final_ip TEXT,
    landing_status TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT,
    total_emails INTEGER,
    phishing_count INTEGER,
    suspicious_count INTEGER,
    spam_count INTEGER,
    quarantine_count INTEGER,
    false_positive_count INTEGER,
    false_negative_count INTEGER,
    avg_handle_seconds REAL,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS digest_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_date TEXT,
    content TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS rule_settings (
    code TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    weight INTEGER,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS security_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS security_allowlist_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS runtime_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_addr TEXT DEFAULT '',
    cc_addr TEXT DEFAULT '',
    bcc_addr TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    body_html TEXT DEFAULT '',
    attachments_json TEXT DEFAULT '[]',
    reply_to_email_id INTEGER REFERENCES emails(id),
    mode TEXT DEFAULT 'compose',
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    from_addr TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    bcc_addr TEXT,
    subject TEXT,
    body_html TEXT,
    attachments_json TEXT DEFAULT '[]',
    status TEXT DEFAULT 'sending',
    error TEXT,
    smtp_response TEXT,
    sent_folder TEXT,
    created_at TEXT,
    sent_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT DEFAULT '',
    company TEXT DEFAULT '',
    note TEXT DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assistant_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT DEFAULT '[]',
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS assistant_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    payload BLOB NOT NULL,
    thumbnail BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_images_message ON assistant_images(message_id);
CREATE TABLE IF NOT EXISTS ai_analysis_cache (
    cache_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_kind ON ai_analysis_cache(kind);
CREATE TRIGGER IF NOT EXISTS assistant_message_images_cleanup AFTER DELETE ON assistant_messages
BEGIN DELETE FROM assistant_images WHERE message_id=OLD.id; END;
"""


@contextmanager
def conn():
    c = sqlite3.connect(config.DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=15000")
    from .mail_search import register
    register(c)
    try:
        yield c
        c.commit()
    finally:
        c.close()


def _columns_of(c, table: str) -> set:
    return {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}


def init_db():
    with conn() as c:
        # WAL lets UI reads continue while background synchronization writes.
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.executescript(SCHEMA)
        _run_migrations(c)
        from .mail_search import initialize
        initialize(c)


def _run_migrations(c):
    """对旧数据库增量添加列/表。"""
    c.execute('CREATE TABLE IF NOT EXISTS briefing_dismissed(email_id INTEGER PRIMARY KEY)')
    if 'user_edited' not in _columns_of(c, 'todos'):
        c.execute('ALTER TABLE todos ADD COLUMN user_edited INTEGER DEFAULT 0')
        c.execute('UPDATE todos SET user_edited=1')  # Legacy edits cannot be distinguished; preserve them all.
    for column, definition in {'stage': "TEXT DEFAULT 'active'", 'kind': "TEXT DEFAULT 'execution'", 'remind_at': 'TEXT'}.items():
        if column not in _columns_of(c, 'todos'):
            c.execute(f'ALTER TABLE todos ADD COLUMN {column} {definition}')
    # Preserve legacy reminders as task reminders, once, in this transaction.
    legacy = c.execute("SELECT value FROM runtime_settings WHERE key='mail_reminders'").fetchone()
    if legacy:
        try:
            reminders = json.loads(legacy['value'])
        except (ValueError, TypeError):
            reminders = {}
        remaining = dict(reminders) if isinstance(reminders, dict) else {}
        for email_id, reminder in list(remaining.items()):
            if not str(email_id).isdigit() or not isinstance(reminder, dict) or not reminder.get('at'):
                continue
            email = c.execute('SELECT subject FROM emails WHERE id=?', (email_id,)).fetchone()
            if not email:
                continue
            task = c.execute("SELECT id,remind_at FROM todos WHERE email_id=? AND status='open' ORDER BY id LIMIT 1", (email_id,)).fetchone()
            if task and task['remind_at'] and task['remind_at'] != reminder['at']:
                task = None  # Preserve a distinct reminder instead of overwriting it.
            if task:
                c.execute('UPDATE todos SET remind_at=?,user_edited=1 WHERE id=?', (reminder['at'], task['id']))
            else:
                c.execute("INSERT INTO todos(email_id,title,status,created_at,remind_at,user_edited) VALUES(?,?,'open',?,?,1)", (email_id, reminder.get('subject') or email['subject'] or '邮件提醒', datetime.now().isoformat(), reminder['at']))
            remaining.pop(email_id)
        c.execute("UPDATE runtime_settings SET value=? WHERE key='mail_reminders'", (json.dumps(remaining, ensure_ascii=False),))
    for column in ("in_reply_to", "references_header"):
        if column not in _columns_of(c, "drafts"):
            c.execute(f"ALTER TABLE drafts ADD COLUMN {column} TEXT DEFAULT ''")
    emails_cols = _columns_of(c, "emails")
    new_email_cols = {
        'arrival_kind': "TEXT DEFAULT ''",
        "in_reply_to": "TEXT",
        "references_header": "TEXT",
        "thread_id": "TEXT",
        "thread_summary": "TEXT",
        "sender_profile_id": "INTEGER",
        "attachment_analysis": "TEXT DEFAULT '[]'",
        "feedback": "TEXT",
        "feedback_note": "TEXT",
        "url_chain": "TEXT DEFAULT '[]'",
        "final_landing_domain": "TEXT",
        "final_landing_ip": "TEXT",
        "review_source": "TEXT",
        "recommended_status": "TEXT DEFAULT 'inbox'",
        "action_mode": "TEXT DEFAULT 'auto'",
        "action_taken": "INTEGER DEFAULT 0",
        "action_reason": "TEXT",
        "is_read": "INTEGER DEFAULT 0",
        "is_starred": "INTEGER DEFAULT 0",
        "is_favorite": "INTEGER DEFAULT 0",
        "is_local_archive": "INTEGER DEFAULT 0",
        "cleanup_hold": "TEXT DEFAULT ''",
        "imap_flags": "TEXT DEFAULT '[]'",
        "body_html": "TEXT",
        "remote_missing": "INTEGER DEFAULT 0",
        "pending_action": "TEXT DEFAULT ''",
        "pending_target": "TEXT DEFAULT ''",
        "pending_target_uid": "INTEGER",
        "pending_due_at": "TEXT",
        "pending_attempts": "INTEGER DEFAULT 0",
        "pending_error": "TEXT DEFAULT ''",
        "recipient_names": "TEXT DEFAULT '{}'",
        "processing_complete": "INTEGER DEFAULT 1",
    }
    for col, dtype in new_email_cols.items():
        if col not in emails_cols:
            c.execute(f"ALTER TABLE emails ADD COLUMN {col} {dtype}")
    if 'uid_validity' not in _columns_of(c, 'sync_state'):
        c.execute('ALTER TABLE sync_state ADD COLUMN uid_validity INTEGER DEFAULT 0')
    if "source_draft_email_id" not in _columns_of(c, "drafts"):
        c.execute("ALTER TABLE drafts ADD COLUMN source_draft_email_id INTEGER")
    for table in ("drafts", "sent_messages"):
        if "attachments_json" not in _columns_of(c, table):
            c.execute(f"ALTER TABLE {table} ADD COLUMN attachments_json TEXT DEFAULT '[]'")
    if 'group_name' not in _columns_of(c, 'contacts'):
        c.execute("ALTER TABLE contacts ADD COLUMN group_name TEXT DEFAULT ''")
    c.execute("CREATE TABLE IF NOT EXISTS server_cleanup_jobs(token TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,result TEXT DEFAULT '{}')")
    c.execute('CREATE TABLE IF NOT EXISTS contact_groups(name TEXT PRIMARY KEY)')
    c.execute("INSERT OR IGNORE INTO contact_groups SELECT DISTINCT group_name FROM contacts WHERE group_name<>''")
    _merge_legacy_cleanup_archives(c)
    c.execute('CREATE TRIGGER IF NOT EXISTS email_revision_update AFTER UPDATE ON emails BEGIN UPDATE mailbox_sequence SET value=value+1 WHERE id=1; END')


# ---------- durable sync jobs ----------

def save_sync_job(operation: str, *, status: str, total: int = 0, processed: int = 0,
                  message: str = "", error: str = ""):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO sync_jobs(job_key,operation,status,total,processed,message,error,updated_at) "
            "VALUES('mailbox',?,?,?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET "
            "operation=excluded.operation,status=excluded.status,total=excluded.total,"
            "processed=excluded.processed,message=excluded.message,error=excluded.error,updated_at=excluded.updated_at",
            (operation or "fetch_all", status, total, processed, message, error, now),
        )


def get_sync_job() -> dict | None:
    with conn() as c:
        row = c.execute("SELECT * FROM sync_jobs WHERE job_key='mailbox'").fetchone()
        return dict(row) if row else None


# ---------- sync_state ----------

def get_last_uid(folder: str) -> int:
    with conn() as c:
        row = c.execute("SELECT last_uid FROM sync_state WHERE folder=?", (folder,)).fetchone()
        return row["last_uid"] if row else 0


def get_uid_validity(folder: str) -> int:
    with conn() as c:
        row = c.execute("SELECT uid_validity FROM sync_state WHERE folder=?", (folder,)).fetchone()
        return int(row["uid_validity"] or 0) if row else 0


def observe_uid_validity(folder: str, value: int, *, reset: bool = False) -> bool:
    """Record a mailbox generation; detach stale UID identities on an approved resync."""
    value = int(value or 0)
    if value <= 0:
        return False
    with conn() as c:
        row = c.execute("SELECT uid_validity FROM sync_state WHERE folder=?", (folder,)).fetchone()
        old = int(row["uid_validity"] or 0) if row else 0
        if old and old != value:
            if not reset:
                raise RuntimeError("服务器邮件编号已变化，请先重新同步文件夹")
            c.execute("DELETE FROM seen_sync_jobs WHERE email_id IN (SELECT id FROM emails WHERE folder=?)", (folder,))
            c.execute(
                "UPDATE emails SET uid=-id,is_local_archive=1,remote_missing=0,"
                "pending_action='',pending_target='',pending_target_uid=NULL,pending_due_at=NULL,"
                "pending_attempts=0,pending_error='' WHERE folder=? AND is_local_archive=0",
                (folder,),
            )
            c.execute(
                "INSERT INTO sync_state(folder,last_uid,uid_validity) VALUES(?,0,?) "
                "ON CONFLICT(folder) DO UPDATE SET last_uid=0,uid_validity=excluded.uid_validity",
                (folder, value),
            )
            return True
        c.execute(
            "INSERT INTO sync_state(folder,last_uid,uid_validity) VALUES(?,0,?) "
            "ON CONFLICT(folder) DO UPDATE SET uid_validity=excluded.uid_validity",
            (folder, value),
        )
    return False


def get_first_uid(folder: str) -> int:
    """当前已处理的最小 UID，用于翻页拉取更早邮件。"""
    with conn() as c:
        row = c.execute(
            "SELECT MIN(uid) AS uid FROM emails WHERE folder=? AND uid>0 AND is_local_archive=0", (folder,)
        ).fetchone()
        return row["uid"] if row and row["uid"] else 0


def set_last_uid(folder: str, uid: int):
    with conn() as c:
        c.execute(
            "INSERT INTO sync_state(folder,last_uid) VALUES(?,?) "
            "ON CONFLICT(folder) DO UPDATE SET last_uid=excluded.last_uid",
            (folder, uid),
        )


# ---------- emails ----------

def upsert_email(e: dict) -> int:
    fields = (
        "uid", "folder", "message_id", "in_reply_to", "references_header", "thread_id",
        "thread_summary", "sender_profile_id", "subject", "from_addr", "from_name", "to_addr", "recipient_names",
        "date", "snippet", "body_text", "body_html", "urls", "attachments", "attachment_analysis", "auth",
        "score", "verdict", "findings", "spam_score", "category", "priority", "summary",
        "llm_phishing", "llm_reasons", "status", "reviewed", "feedback", "feedback_note",
        "url_chain", "final_landing_domain", "final_landing_ip", "review_source",
        "recommended_status", "action_mode", "action_taken", "action_reason",
        "raw_path", "created_at", "arrival_kind", "processing_complete",
    )
    e = dict(e)
    e.setdefault("folder", "INBOX")
    supplied = set(e)
    for k in ("urls", "attachments", "attachment_analysis", "auth", "findings", "llm_reasons", "url_chain", "imap_flags", "recipient_names"):
        if k in e and not isinstance(e.get(k), str):
            object_default = k in {"auth", "recipient_names"}
            e[k] = json.dumps(e.get(k) or ({} if object_default else []), ensure_ascii=False)
    e.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))
    fields = tuple(k for k in fields if k in e)
    values = [e.get(k) for k in fields]
    placeholders = ",".join("?" for _ in fields)
    # REPLACE deletes the old row and assigns a new id, breaking source links.
    # Update only supplied data, retaining read/star state and original creation time.
    updates = [k for k in fields if k in supplied and k not in ("uid", "folder", "created_at")]
    conflict = ("DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in updates)) if updates else "DO NOTHING"
    with conn() as c:
        # Portable imports deliberately discard source-server UIDs.  On the
        # first target-server sync, bind an archived copy to its new UID by the
        # stable Message-ID before the normal upsert, preserving local links.
        message_id = str(e.get("message_id") or "").strip()
        if message_id:
            occupied = c.execute("SELECT id FROM emails WHERE folder=? AND uid=?",
                                 (e.get("folder", "INBOX"), e["uid"])).fetchone()
            imported = c.execute(
                "SELECT id FROM emails WHERE is_local_archive=1 AND message_id=? AND folder=? ORDER BY id LIMIT 1",
                (message_id, e.get("folder", "INBOX")),
            ).fetchone()
            if imported and not occupied:
                c.execute("UPDATE emails SET folder=?,uid=?,is_local_archive=0,remote_missing=0 WHERE id=?",
                          (e.get("folder", "INBOX"), e["uid"], imported["id"]))
        c.execute(
            f"INSERT INTO emails({','.join(fields)}) VALUES({placeholders}) ON CONFLICT(folder,uid) {conflict}",
            values,
        )
        row = c.execute(
            "SELECT id FROM emails WHERE folder=? AND uid=?",
            (e.get("folder", "INBOX"), e["uid"]),
        ).fetchone()
        return row["id"]


def already_processed(folder: str, uid: int) -> bool:
    with conn() as c:
        return c.execute(
            "SELECT 1 FROM emails WHERE folder=? AND uid=? AND processing_complete=1", (folder, uid)
        ).fetchone() is not None


def finish_email_processing(email_id: int):
    with conn() as c:
        c.execute("UPDATE emails SET processing_complete=1 WHERE id=?", (email_id,))


def get_ai_analysis_cache(cache_key: str) -> dict | None:
    """Return one reusable model result; corrupt cache entries fail closed."""
    with conn() as c:
        row = c.execute(
            "SELECT result FROM ai_analysis_cache WHERE cache_key=?", (cache_key,)
        ).fetchone()
    if not row:
        return None
    try:
        value = json.loads(row["result"])
        return value if isinstance(value, dict) else None
    except (TypeError, ValueError):
        return None


def save_ai_analysis_cache(cache_key: str, kind: str, model: str, result: dict):
    with conn() as c:
        c.execute(
            "INSERT INTO ai_analysis_cache(cache_key,kind,model,result,created_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(cache_key) DO UPDATE SET result=excluded.result,created_at=excluded.created_at",
            (cache_key, kind, model, json.dumps(result, ensure_ascii=False),
             datetime.now().isoformat(timespec="seconds")),
        )


def count_history_imported() -> int:
    """Count durable history rows so paged imports share one global AI window."""
    with conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE arrival_kind='history'"
        ).fetchone()
        return int(row["n"] or 0)


def folder_uids(folder: str) -> set[int]:
    """Return locally known UIDs for incremental server-folder synchronization."""
    with conn() as c:
        return {int(row["uid"]) for row in c.execute(
            "SELECT uid FROM emails WHERE folder=? AND uid>0 AND is_local_archive=0", (folder,)
        ).fetchall()}


def _decode_rows(rows):
    out = []
    for r in rows:
        d = dict(r)
        for k in ("urls", "attachments", "attachment_analysis", "findings", "llm_reasons", "url_chain", "imap_flags", "recipient_names"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except (TypeError, json.JSONDecodeError):
                d[k] = []
        try:
            d["auth"] = json.loads(d.get("auth") or "{}")
        except (TypeError, json.JSONDecodeError):
            d["auth"] = {}
        out.append(d)
    return out


EMAIL_LIST_COLUMNS = (
    'id,uid,folder,message_id,thread_id,subject,from_addr,from_name,to_addr,date,'
    'snippet,summary,attachments,score,verdict,status,category,priority,reviewed,'
    'feedback,recommended_status,is_read,is_starred,is_favorite,is_local_archive,created_at,arrival_kind,pending_action,pending_error'
)


def list_emails(status=None, verdict=None, days=7, limit=1000, folder=None, offset=0,
                metadata_only=False, list_view=False):
    # Historical mail may be imported today. Lists and reports must follow the
    # message's real received date, not the local indexing timestamp.
    columns = ('id,thread_id,status,priority,from_addr,subject,date,verdict,score,feedback,reviewed,arrival_kind'
               if metadata_only else EMAIL_LIST_COLUMNS if list_view else '*')
    visibility = "(pending_action IN ('trash','trash_copying','trash_copied','trash_locating') OR (remote_missing=0 AND status='trash'))" if status == 'trash' else 'remote_missing=0'
    sql = f"SELECT {columns} FROM emails WHERE {visibility} AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?)"
    args = [f"-{days} days"]
    if status == "favorites":
        sql += " AND is_favorite=1"
    elif status and status != "trash":
        sql += " AND status=?"
        args.append(status)
    if verdict:
        sql += " AND verdict=?"
        args.append(verdict)
    if folder:
        sql += " AND folder=?"
        args.append(folder)
    sql += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
    args.extend([limit, max(0, offset)])
    with conn() as c:
        rows = c.execute(sql, args).fetchall()
        return [dict(row) for row in rows] if metadata_only else _decode_rows(rows)


def iter_emails(batch_size=25):
    """Keyset batches for startup repair; close each cursor before any writes."""
    with conn() as c:
        ceiling = c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
    cursor = 0
    while cursor < ceiling:
        with conn() as c:
            rows = _decode_rows(c.execute(
                'SELECT * FROM emails WHERE remote_missing=0 AND id>? AND id<=? ORDER BY id LIMIT ?',
                (cursor, ceiling, max(1, min(batch_size, 100))),
            ).fetchall())
        if not rows:
            return
        cursor = rows[-1]['id']
        yield from rows


def notification_candidates(after_id: int):
    """Stream only new notification metadata, never historical bodies/attachments."""
    with conn() as c:
        rows = c.execute(
            "SELECT id,thread_id,status,priority,from_addr,verdict,score,feedback,reviewed "
            "FROM emails WHERE id>? AND remote_missing=0 AND "
            "datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime','-2 days')",
            (after_id,),
        )
        for row in rows:
            yield dict(row)


def mailbox_revision() -> dict:
    """Return a cheap token that changes when the visible local mailbox changes."""
    with conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS total, COALESCE(MAX(id),0) AS latest_id "
            "FROM emails WHERE remote_missing=0"
        ).fetchone()
        sequence = c.execute('SELECT value FROM mailbox_sequence WHERE id=1').fetchone()[0]
    total = int(row["total"] or 0)
    latest_id = int(row["latest_id"] or 0)
    return {"revision": f"{latest_id}:{total}:{sequence}", "latest_id": latest_id, "total": total}


def search_emails(terms: list[str], limit: int = 200, offset: int = 0,
                  list_view: bool = False, folder: str = "") -> list[dict]:
    """在完整本地邮箱上执行参数化全文模糊检索，不受列表页 2000 封限制。"""
    cleaned = [str(term).strip().lower()[:80] for term in terms if str(term).strip()][:12]
    if not cleaned:
        return list_emails(days=9999, limit=limit, offset=offset, list_view=list_view)
    columns = EMAIL_LIST_COLUMNS if list_view else '*'
    with conn() as c:
        from .mail_search import predicate
        condition, args = predicate(c, cleaned)
        if folder:
            condition += ' AND folder=?'
            args.append(folder)
        sql = f"SELECT {columns} FROM emails WHERE remote_missing=0 AND {condition} ORDER BY date DESC,id DESC LIMIT ? OFFSET ?"
        args.extend([max(1, min(limit, 1000)), max(0, offset)])
        return _decode_rows(c.execute(sql, args).fetchall())


def list_correspondence_emails(address: str, limit: int = 50) -> list[dict]:
    """Return locally stored mail exchanged with one exact email address."""
    target = str(address or "").strip().casefold()
    if not target:
        return []
    with conn() as c:
        candidates = _decode_rows(c.execute(
            "SELECT * FROM emails WHERE remote_missing=0 AND "
            "(lower(coalesce(from_addr,''))=? OR lower(coalesce(to_addr,'')) LIKE ?) "
            "ORDER BY date DESC,id DESC LIMIT ?",
            (target, f"%{target}%", max(20, min(int(limit) * 4, 400))),
        ).fetchall())
    import re
    address_pattern = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
    result = []
    for row in candidates:
        sender = str(row.get("from_addr") or "").strip().casefold()
        recipients = {value.casefold() for value in address_pattern.findall(str(row.get("to_addr") or ""))}
        if sender == target or target in recipients:
            result.append(row)
        if len(result) >= max(1, min(int(limit), 100)):
            break
    return result


def list_attachments(limit: int = 500) -> list[dict]:
    """汇总本地邮件附件元数据，供附件中心检索与下载。"""
    with conn() as c:
        rows = _decode_rows(c.execute(
            "SELECT id,subject,from_addr,date,attachments,score,verdict,feedback,reviewed FROM emails "
            "WHERE remote_missing=0 AND attachments IS NOT NULL AND attachments NOT IN ('','[]') ORDER BY date DESC LIMIT 2000"
        ).fetchall())
    result = []
    for row in rows:
        for index, item in enumerate(row.get("attachments") or []):
            result.append({"email_id": row["id"], "index": index,
                           "name": item.get("name") or "未命名附件",
                           "content_type": item.get("content_type") or "application/octet-stream",
                           "size": item.get("size") or 0, "subject": row.get("subject") or "",
                           "from_addr": row.get("from_addr") or "", "date": row.get("date") or "",
                           "score": row.get("score") or 0, "verdict": row.get("verdict") or "clean",
                           "feedback": row.get("feedback"), "reviewed": row.get("reviewed")})
            if len(result) >= limit:
                return result
    return result


def list_inline_attachment_candidates() -> list[dict]:
    """列出可能混入签名图片的历史邮件，供一次性元数据修复。"""
    patterns = ("%image/%", "%.jpg%", "%.jpeg%", "%.png%", "%.gif%", "%.webp%")
    with conn() as c:
        rows = c.execute(
            "SELECT id,raw_path,attachments FROM emails WHERE remote_missing=0 "
            "AND raw_path IS NOT NULL AND raw_path<>'' AND attachments IS NOT NULL "
            "AND attachments NOT IN ('','[]') AND (" +
            " OR ".join("lower(attachments) LIKE ?" for _ in patterns) + ")",
            patterns,
        ).fetchall()
    return _decode_rows(rows)


def update_attachment_metadata(email_id: int, attachments: list[dict]):
    with conn() as c:
        c.execute(
            "UPDATE emails SET attachments=? WHERE id=?",
            (json.dumps(attachments or [], ensure_ascii=False), email_id),
        )


def audit_action_exists(action: str) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM audit_logs WHERE action=? LIMIT 1", (action,)).fetchone() is not None


def get_email(email_id: int):
    with conn() as c:
        rows = _decode_rows(c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchall())
    return rows[0] if rows else None


def get_email_by_folder_uid(folder: str, uid: int):
    with conn() as c:
        rows = _decode_rows(c.execute(
            "SELECT * FROM emails WHERE folder=? AND uid=?", (folder, uid)
        ).fetchall())
    return rows[0] if rows else None


def list_special_folder_emails(status: str, limit: int = 1000):
    """Historical server-side Sent/Drafts imported from IMAP folders."""
    if status not in ("sent", "draft"):
        return []
    with conn() as c:
        return _decode_rows(c.execute(
            "SELECT * FROM emails WHERE remote_missing=0 AND status=? ORDER BY date DESC,id DESC LIMIT ?",
            (status, max(1, min(limit, 5000))),
        ).fetchall())


def set_status(email_id: int, status: str, folder: str | None = None):
    with conn() as c:
        if folder:
            c.execute("UPDATE emails SET status=?, folder=? WHERE id=?", (status, folder, email_id))
        else:
            c.execute("UPDATE emails SET status=? WHERE id=?", (status, email_id))


def reconcile_folder(folder: str, present_uids: list[int]) -> int:
    """Hide messages removed elsewhere while retaining local evidence and todo links."""
    uids = list(dict.fromkeys(int(uid) for uid in present_uids))
    with conn() as c:
        before = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE folder=? AND remote_missing=0", (folder,)
        ).fetchone()["n"]
        c.execute("UPDATE emails SET remote_missing=1 WHERE folder=? AND is_local_archive=0", (folder,))
        c.executemany("UPDATE emails SET remote_missing=0 WHERE folder=? AND uid=? AND COALESCE(pending_action,'')=''",
                      ((folder, uid) for uid in uids))
        after = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE folder=? AND remote_missing=0", (folder,)
        ).fetchone()["n"]
    return max(0, before - after)


def set_remote_missing(email_id: int, value: bool = True):
    """Hide a server-removed row while preserving its local evidence and audit links."""
    with conn() as c:
        c.execute("UPDATE emails SET remote_missing=? WHERE id=? AND is_local_archive=0", (int(value), email_id))


def queue_trash(email_ids: list[int], delay_seconds: int = 120) -> tuple[list[dict], list[dict]]:
    """Hide messages immediately and persist an idempotent server-trash operation."""
    ids = list(dict.fromkeys(int(value) for value in email_ids))
    if not ids:
        return [], []
    due = datetime.fromtimestamp(datetime.now().timestamp() + max(0, delay_seconds)).isoformat(timespec="seconds")
    before, after = [], []
    keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred', 'remote_missing',
            'pending_action', 'pending_target', 'pending_target_uid')
    with conn() as c:
        for email_id in ids:
            row = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row or row['is_local_archive'] or row['cleanup_hold'] or row['remote_missing'] or row['pending_action'] or row['status'] == 'trash':
                continue
            before.append({key: row[key] for key in keys})
            c.execute(
                "UPDATE emails SET remote_missing=1,pending_action='trash',pending_target='',"
                "pending_target_uid=NULL,pending_due_at=?,pending_attempts=0,pending_error='' WHERE id=?",
                (due, email_id),
            )
            updated = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            after.append({key: updated[key] for key in keys})
    return before, after


def due_trash_actions(limit: int = 200) -> list[dict]:
    """Return due phases. Rows remain queued until their remote phase is committed."""
    with conn() as c:
        return [dict(row) for row in c.execute(
            "SELECT * FROM emails WHERE pending_action IN ('trash','trash_copying','trash_copied','trash_locating') "
            "AND COALESCE(pending_due_at,'')<=? ORDER BY pending_due_at,id LIMIT ?",
            (datetime.now().isoformat(timespec="seconds"), max(1, min(limit, 200))),
        ).fetchall()]


def advance_trash_action(email_ids: list[int], *, action: str, target: str = '',
                         target_uids: dict[int, int | None] | None = None):
    ids = list(dict.fromkeys(int(value) for value in email_ids))
    if not ids:
        return
    target_uids = target_uids or {}
    with conn() as c:
        for email_id in ids:
            c.execute(
                "UPDATE emails SET pending_action=?,pending_target=?,pending_target_uid=?,"
                "pending_due_at=?,pending_error='' WHERE id=?",
                (action, target, target_uids.get(email_id), datetime.now().isoformat(timespec="seconds"), email_id),
            )


def retry_trash_action(email_ids: list[int], error: str):
    """Back off persistent IMAP failures without exposing a deleted row again."""
    now = datetime.now()
    with conn() as c:
        for email_id in dict.fromkeys(int(value) for value in email_ids):
            row = c.execute("SELECT pending_attempts FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row:
                continue
            attempts = int(row['pending_attempts'] or 0) + 1
            delay = min(300, 5 * (2 ** min(attempts - 1, 6)))
            due = datetime.fromtimestamp(now.timestamp() + delay).isoformat(timespec="seconds")
            c.execute(
                "UPDATE emails SET pending_attempts=?,pending_due_at=?,pending_error=? WHERE id=?",
                (attempts, due, str(error or '')[:300], email_id),
            )


def finish_trash_action(email_id: int, target: str, target_uid: int | None):
    """Commit the local result; unknown target UIDs are learned by the next folder sync."""
    with conn() as c:
        if target_uid:
            canonical = c.execute(
                "SELECT id FROM emails WHERE folder=? AND uid=? AND id<>?",
                (target, int(target_uid), email_id),
            ).fetchone()
            if canonical:
                c.execute("UPDATE emails SET status='trash',remote_missing=0 WHERE id=?", (canonical['id'],))
                c.execute(
                    "UPDATE emails SET status='trash',remote_missing=1,pending_action='',pending_target='',"
                    "pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=?",
                    (email_id,),
                )
            else:
                c.execute(
                    "UPDATE emails SET folder=?,uid=?,status='trash',remote_missing=0,pending_action='',"
                    "pending_target='',pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' "
                    "WHERE id=?",
                    (target, int(target_uid), email_id),
                )
        else:
            c.execute(
                "UPDATE emails SET status='trash',remote_missing=1,pending_action='trash_locating',pending_target=?,"
                "pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=?",
                (target, email_id),
            )



def cancel_pending_trash(email_id: int) -> bool:
    from .trash_queue import mutation_lock
    with mutation_lock():
        return _cancel_pending_trash(email_id)


def _cancel_pending_trash(email_id: int) -> bool:
    """Cancel an operation only before the remote copy phase has started."""
    with conn() as c:
        c.execute(
            "UPDATE emails SET remote_missing=0,pending_action='',pending_target='',pending_target_uid=NULL,"
            "pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=? AND pending_action='trash'",
            (email_id,),
        )
        return bool(c.execute("SELECT changes()").fetchone()[0])


def set_mail_state(email_id: int, *, is_read: bool | None = None,
                   is_starred: bool | None = None, folder: str | None = None,
                   uid: int | None = None):
    """更新邮件客户端状态；只修改明确传入的字段。"""
    sets, args = [], []
    for column, value in (("is_read", is_read), ("is_starred", is_starred)):
        if value is not None:
            sets.append(f"{column}=?")
            args.append(1 if value else 0)
    if folder is not None:
        sets.append("folder=?")
        args.append(folder)
    if uid is not None:
        sets.append("uid=?")
        args.append(uid)
    if not sets:
        return
    args.append(email_id)
    with conn() as c:
        c.execute(f"UPDATE emails SET {', '.join(sets)} WHERE id=?", args)


def sync_mail_flags(email_id: int, *, is_read: bool, is_starred: bool):
    """Refresh server flags without overwriting a newer queued local read choice."""
    with conn() as c:
        c.execute(
            "UPDATE emails SET is_read=CASE WHEN EXISTS(SELECT 1 FROM seen_sync_jobs "
            "WHERE email_id=?) THEN is_read ELSE ? END,is_starred=? WHERE id=? AND is_local_archive=0",
            (int(email_id), int(bool(is_read)), int(bool(is_starred)), int(email_id)),
        )


def queue_seen_sync(email_ids: list[int], value: bool) -> tuple[list[dict], list[dict]]:
    """Apply the read state locally and persist only the latest remote intent."""
    ids = list(dict.fromkeys(int(item) for item in email_ids))
    if not ids:
        return [], []
    now = datetime.now().isoformat(timespec="seconds")
    keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred')
    before, after = [], []
    with conn() as c:
        for email_id in ids:
            row = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row or row['remote_missing']:
                continue
            before.append({key: row[key] for key in keys})
            c.execute("UPDATE emails SET is_read=? WHERE id=?", (int(bool(value)), email_id))
            if row['is_local_archive']:
                after.append({key: (int(bool(value)) if key == 'is_read' else row[key]) for key in keys})
                continue
            c.execute(
                "INSERT INTO seen_sync_jobs(email_id,desired_value,generation,attempts,due_at,last_error,updated_at) "
                "VALUES(?,?,1,0,?,'',?) ON CONFLICT(email_id) DO UPDATE SET "
                "desired_value=excluded.desired_value,generation=seen_sync_jobs.generation+1,"
                "attempts=0,due_at=excluded.due_at,last_error='',updated_at=excluded.updated_at",
                (email_id, int(bool(value)), now, now),
            )
            updated = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            after.append({key: updated[key] for key in keys})
    return before, after


def due_seen_sync_jobs(limit: int = 200) -> list[dict]:
    """Return due read-state writes with their current server identity."""
    with conn() as c:
        return [dict(row) for row in c.execute(
            "SELECT j.*,e.folder,e.uid,e.remote_missing FROM seen_sync_jobs j "
            "LEFT JOIN emails e ON e.id=j.email_id WHERE j.due_at<=? "
            "ORDER BY j.due_at,j.email_id LIMIT ?",
            (datetime.now().isoformat(timespec="seconds"), max(1, min(limit, 500))),
        ).fetchall()]


def finish_seen_sync(email_id: int, generation: int):
    """A newer local toggle must survive completion of an older network write."""
    with conn() as c:
        c.execute("DELETE FROM seen_sync_jobs WHERE email_id=? AND generation=?",
                  (int(email_id), int(generation)))


def retry_seen_sync(email_ids: list[tuple[int, int]], error: str):
    now = datetime.now()
    with conn() as c:
        for email_id, generation in email_ids:
            row = c.execute(
                "SELECT attempts FROM seen_sync_jobs WHERE email_id=? AND generation=?",
                (int(email_id), int(generation)),
            ).fetchone()
            if not row:
                continue
            attempts = int(row['attempts'] or 0) + 1
            delay = min(300, 5 * (2 ** min(attempts - 1, 6)))
            due = datetime.fromtimestamp(now.timestamp() + delay).isoformat(timespec="seconds")
            c.execute(
                "UPDATE seen_sync_jobs SET attempts=?,due_at=?,last_error=?,updated_at=? "
                "WHERE email_id=? AND generation=?",
                (attempts, due, str(error or '')[:300], now.isoformat(timespec="seconds"),
                 int(email_id), int(generation)),
            )


# ---------- drafts ----------

def save_draft(data: dict, draft_id: int | None = None) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    fields = ("to_addr", "cc_addr", "bcc_addr", "subject", "body_html", "attachments_json",
              "reply_to_email_id", "mode", "in_reply_to", "references_header", "source_draft_email_id")
    data = dict(data)
    data["references_header"] = data.get("references", "")
    data["attachments_json"] = json.dumps(data.get("attachments") or [], ensure_ascii=False)
    values = [data.get(k) for k in fields]
    with conn() as c:
        if draft_id:
            c.execute(
                "UPDATE drafts SET to_addr=?,cc_addr=?,bcc_addr=?,subject=?,body_html=?,attachments_json=?,"
                "reply_to_email_id=?,mode=?,in_reply_to=?,references_header=?,source_draft_email_id=?,updated_at=? WHERE id=?",
                (*values, now, draft_id),
            )
            if c.execute("SELECT changes() AS n").fetchone()["n"]:
                return draft_id
        cur = c.execute(
            "INSERT INTO drafts(to_addr,cc_addr,bcc_addr,subject,body_html,attachments_json,reply_to_email_id,mode,in_reply_to,references_header,source_draft_email_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (*values, now, now),
        )
        return cur.lastrowid


def list_drafts():
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,to_addr,cc_addr,bcc_addr,subject,substr(body_html,1,1000) AS body_html,"
            "attachments_json,reply_to_email_id,mode,in_reply_to,references_header,"
            "source_draft_email_id,created_at,updated_at FROM drafts ORDER BY updated_at DESC"
        ).fetchall()]
    for row in rows:
        row["references"] = row.get("references_header") or ""
        try: attachments = json.loads(row.pop("attachments_json") or "[]")
        except json.JSONDecodeError: row["attachments"] = []
        else:
            row["attachments"] = [{k: v for k, v in item.items() if k != "data_base64"}
                                  for item in attachments if isinstance(item, dict)]
    return rows


def get_draft(draft_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM drafts WHERE id=?", (draft_id,)).fetchone()
        result = dict(row) if row else None
    if result:
        result["references"] = result.get("references_header") or ""
        try: result["attachments"] = json.loads(result.get("attachments_json") or "[]")
        except json.JSONDecodeError: result["attachments"] = []
    return result


def complete_sent_draft(draft_id):
    draft = get_draft(draft_id) if draft_id else None
    if not draft:
        return
    source_id = draft.get('source_draft_email_id')
    source = get_email(source_id) if source_id else None
    if source and source.get('status') == 'draft':
        queue_trash([source_id], delay_seconds=0)
    delete_draft(draft_id)


def delete_draft(draft_id: int):
    with conn() as c:
        c.execute("DELETE FROM drafts WHERE id=?", (draft_id,))


def create_sent_message(data: dict) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,cc_addr,bcc_addr,subject,body_html,attachments_json,status,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (data.get("message_id"), data.get("from_addr"), data.get("to_addr"),
             data.get("cc_addr"), data.get("bcc_addr"), data.get("subject"),
             data.get("body_html"), json.dumps(data.get("attachments") or [], ensure_ascii=False), "sending", now),
        )
        record_id = cur.lastrowid
        from .outbox import current_send_token
        if current_send_token.get():
            c.execute('UPDATE outbox SET result=? WHERE token=?', (json.dumps({'sent_record_id':record_id}), current_send_token.get()))
        return record_id


def finish_sent_message(record_id: int, *, ok: bool, error: str = "",
                        smtp_response: str = "", sent_folder: str = "", message_id: str = ""):
    with conn() as c:
        c.execute(
            "UPDATE sent_messages SET status=?,error=?,smtp_response=?,sent_folder=?,sent_at=?,"
            "message_id=COALESCE(NULLIF(?,''),message_id) WHERE id=?",
            ("sent" if ok else "failed", error, smtp_response, sent_folder,
             datetime.now().isoformat(timespec="seconds") if ok else None, message_id, record_id),
        )


def list_sent_messages(limit: int = 500):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,message_id,from_addr,to_addr,cc_addr,bcc_addr,subject,"
            "substr(body_html,1,1000) AS body_html,attachments_json,status,error,smtp_response,"
            "sent_folder,created_at,sent_at FROM sent_messages "
            "ORDER BY COALESCE(sent_at,created_at) DESC LIMIT ?", (max(1, min(limit, 500)),)
        ).fetchall()]
    for row in rows:
        try:
            attachments = json.loads(row.pop("attachments_json") or "[]")
        except json.JSONDecodeError:
            row["attachments"] = []
        else:
            row["attachments"] = [{k: v for k, v in item.items() if k != "data_base64"}
                                  for item in attachments if isinstance(item, dict)]
    return rows


def get_sent_message(record_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM sent_messages WHERE id=?", (record_id,)).fetchone()
        result = dict(row) if row else None
    if result:
        try:
            result["attachments"] = json.loads(result.get("attachments_json") or "[]")
        except json.JSONDecodeError:
            result["attachments"] = []
    return result


def get_sent_attachment(record_id: int, index: int, *, draft=False):
    """Decode an attachment from this account's persisted outgoing message."""
    import base64
    import binascii
    row = get_draft(record_id) if draft else get_sent_message(record_id)
    if not row or index < 0 or index >= len(row['attachments']):
        return None
    item = row['attachments'][index]
    if not isinstance(item, dict) or 'data_base64' not in item:
        return None
    try:
        payload = base64.b64decode(item['data_base64'], validate=True)
    except (ValueError, TypeError, binascii.Error):
        return None
    return {'name': str(item.get('filename') or item.get('name') or '附件'),
            'content_type': item.get('content_type') or 'application/octet-stream',
            'payload': payload, 'size': len(payload)}


# ---------- assistant conversations ----------

def create_assistant_conversation(title: str) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute("INSERT INTO assistant_conversations(title,created_at,updated_at) VALUES(?,?,?)",
                        ((title or "新对话")[:60], now, now))
        return cur.lastrowid


def add_assistant_message(conversation_id: int, role: str, content: str, sources: list | None = None, images=None):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute("INSERT INTO assistant_messages(conversation_id,role,content,sources,created_at) VALUES(?,?,?,?,?)",
                  (conversation_id, role, content, json.dumps(sources or [], ensure_ascii=False), now))
        message_id = cur.lastrowid
        for image in images or []:
            c.execute("INSERT INTO assistant_images(message_id,mime,payload,thumbnail) VALUES(?,?,?,?)",
                      (message_id, image['history_mime'], image['history_data'], image['thumbnail']))
        c.execute("UPDATE assistant_conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return message_id


def list_assistant_conversations(limit: int = 50):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT c.*,COUNT(m.id) AS message_count FROM assistant_conversations c "
            "LEFT JOIN assistant_messages m ON m.conversation_id=c.id GROUP BY c.id "
            "ORDER BY c.updated_at DESC LIMIT ?", (max(1, min(limit, 100)),)
        ).fetchall()]


def get_assistant_messages(conversation_id: int):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY id", (conversation_id,)
        ).fetchall()]
        images = c.execute("SELECT i.id,i.message_id FROM assistant_images i JOIN assistant_messages m "
                           "ON m.id=i.message_id WHERE m.conversation_id=? ORDER BY i.id", (conversation_id,)).fetchall()
    by_message = {}
    for image in images:
        path = f"/api/assistant/images/{image['id']}"
        by_message.setdefault(image['message_id'], []).append({'url': path, 'thumbnail_url': path + '?thumbnail=true'})
    for row in rows:
        row['images'] = by_message.get(row['id'], [])
        try:
            row["sources"] = json.loads(row.get("sources") or "[]")
        except json.JSONDecodeError:
            row["sources"] = []
    return rows


def get_assistant_image(image_id: int, thumbnail=False):
    # Select only the requested representation, never all image BLOBs in a chat.
    column = 'thumbnail' if thumbnail else 'payload'
    with conn() as c:
        row = c.execute(f"SELECT mime,{column} AS data FROM assistant_images WHERE id=?", (image_id,)).fetchone()
    return dict(row) if row else None


def assistant_conversation_exists(conversation_id: int) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM assistant_conversations WHERE id=?", (conversation_id,)).fetchone() is not None


def set_reviewed(email_id: int):
    with conn() as c:
        c.execute("UPDATE emails SET reviewed=1 WHERE id=?", (email_id,))


def update_llm(email_id: int, category=None, priority=None, summary=None,
               llm_phishing=None, llm_reasons=None):
    sets, args = [], []
    for col, val in (("category", category), ("priority", priority), ("summary", summary),
                     ("llm_phishing", llm_phishing)):
        if val is not None:
            sets.append(f"{col}=?")
            args.append(val)
    if llm_reasons is not None:
        sets.append("llm_reasons=?")
        args.append(json.dumps(llm_reasons, ensure_ascii=False))
    if not sets:
        return
    args.append(email_id)
    with conn() as c:
        c.execute(f"UPDATE emails SET {', '.join(sets)} WHERE id=?", args)


def stats_today():
    with conn() as c:
        def n(where=""):
            return c.execute(
                f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND date(COALESCE(NULLIF(date,''),created_at))="
                f"date('now','localtime') {where}"
            ).fetchone()["n"]
        return {
            "today": n(),
            "quarantine": n("AND status='quarantine'"),
            "suspicious": n("AND verdict='suspicious' AND status='inbox'"),
            "spam": n("AND status='spam'"),
            "todos_open": c.execute(
                "SELECT COUNT(*) AS n FROM todos WHERE status='open'"
            ).fetchone()["n"],
        }


def frequent_sender_domains(limit=30):
    """历史邮件里的高频发件域名，用于仿冒检测白名单。"""
    with conn() as c:
        rows = c.execute(
            "SELECT lower(substr(from_addr, instr(from_addr,'@')+1)) AS d, COUNT(*) AS n "
            "FROM emails WHERE remote_missing=0 AND from_addr LIKE '%@%' "
            "GROUP BY d ORDER BY n DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [r["d"] for r in rows if r["d"]]


_recipient_header_name_cache: dict[tuple, dict[str, str]] = {}


def _contact_name_is_placeholder(name: str, address: str) -> bool:
    """Return true for aliases that merely repeat the email or its local part."""
    value = str(name or "").strip(' \t\r\n"').casefold()
    normalized_address = str(address or "").strip().casefold()
    local_part = normalized_address.partition("@")[0]
    return not value or "@" in value or value in {normalized_address, local_part}


def _recipient_header_display_names(c) -> dict[str, str]:
    """Build a revision-scoped address book from locally stored RFC822 headers."""
    database_path = next((row[2] for row in c.execute("PRAGMA database_list") if row[1] == "main"), config.DB_PATH)
    revision = c.execute(
        "SELECT COUNT(*),COALESCE(MAX(id),0),(SELECT value FROM mailbox_sequence WHERE id=1) "
        "FROM emails WHERE remote_missing=0"
    ).fetchone()
    key = (database_path, int(revision[0]), int(revision[1]), int(revision[2]))
    cached = _recipient_header_name_cache.get(key)
    if cached is not None:
        return cached
    names: dict[str, str] = {}
    from .parser import recipient_names_from_raw_path
    names_column = "recipient_names" if "recipient_names" in _columns_of(c, "emails") else "'' AS recipient_names"
    if names_column.startswith("recipient_names"):
        rows = c.execute(
            "SELECT recipient_names,raw_path FROM emails WHERE remote_missing=0 "
            "AND (trim(coalesce(raw_path,''))<>'' OR "
            "trim(coalesce(recipient_names,'')) NOT IN ('','{}','[]')) "
            "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC"
        ).fetchall()
    else:
        rows = c.execute(
            f"SELECT {names_column},raw_path FROM emails WHERE remote_missing=0 "
            "AND trim(coalesce(raw_path,''))<>'' "
            "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC"
        ).fetchall()
    for row in rows:
        try:
            pairs = json.loads(row["recipient_names"] or "{}")
        except (TypeError, json.JSONDecodeError):
            pairs = {}
        if not isinstance(pairs, dict):
            pairs = {}
        if not pairs:
            pairs = recipient_names_from_raw_path(row["raw_path"] or "")
        for address, name in pairs.items():
            address = str(address or "").strip().casefold()
            name = str(name or "").strip()
            if not address or not name:
                continue
            # Prefer a Chinese display name over an older username-like alias.
            if address not in names or (any('\u3400' <= char <= '\u9fff' for char in name)
                                        and not any('\u3400' <= char <= '\u9fff' for char in names[address])):
                names[address] = name[:160]
    _recipient_header_name_cache[key] = names
    while len(_recipient_header_name_cache) > 8:
        _recipient_header_name_cache.pop(next(iter(_recipient_header_name_cache)))
    return names


def contact_display_names(addresses, *, connection=None) -> dict[str, dict]:
    """Resolve exact email addresses to locally learned names without mutating mail."""
    wanted = {
        address.strip().casefold()
        for value in addresses or []
        for _name, address in getaddresses([str(value or "")])
        if address.strip() and "@" in address
    }
    if not wanted:
        return {}
    result: dict[str, dict] = {}
    scores: dict[str, int] = {}

    def useful(name: str, address: str) -> str:
        value = str(name or "").strip(' \t\r\n"')[:160]
        return "" if _contact_name_is_placeholder(value, address) else value

    def remember(address: str, name: str, source: str, base_score: int, *, allow_placeholder: bool = False):
        address = str(address or "").strip().casefold()
        name = str(name or "").strip(' \t\r\n"')[:160] if allow_placeholder else useful(name, address)
        if not name or address not in wanted:
            return
        chinese = any('\u3400' <= char <= '\u9fff' for char in name)
        score = base_score + (30 if chinese else 0)
        if score > scores.get(address, -1):
            scores[address] = score
            result[address] = {"name": name, "source": source}

    def resolve(c):
        for address, name in _recipient_header_display_names(c).items():
            remember(address, name, "header", 30)
        # SQLite builds can have a low placeholder limit, so keep exact lookups bounded.
        values = sorted(wanted)
        for start in range(0, len(values), 400):
            batch = values[start:start + 400]
            marks = ",".join("?" for _ in batch)
            rows = c.execute(
                f"SELECT lower(from_addr) AS email,from_name,date,id FROM emails "
                f"WHERE remote_missing=0 AND lower(from_addr) IN ({marks}) "
                "AND trim(coalesce(from_name,''))<>'' "
                "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC",
                batch,
            ).fetchall()
            for row in rows:
                address = str(row["email"] or "").casefold()
                remember(address, row["from_name"], "history", 40)
            saved = c.execute(
                f"SELECT lower(email) AS email,name,source,hidden FROM contacts "
                f"WHERE lower(email) IN ({marks})",
                batch,
            ).fetchall()
            for row in saved:
                address = str(row["email"] or "").casefold()
                if row["hidden"]:
                    result.pop(address, None)
                    scores[address] = 1000
                    continue
                manual = row["source"] == "manual"
                remember(address, row["name"], "manual" if manual else "contact",
                         100 if manual else 35, allow_placeholder=manual)

    if connection is not None:
        resolve(connection)
    else:
        with conn() as c:
            resolve(c)
    return result


def search_contacts(query: str = "", limit: int = 20, favorites_only: bool = False, group_name: str = ""):
    """合并个人通讯录和邮件往来历史；个人名称、收藏与隐藏状态优先。"""
    query = (query or "").strip().lower()
    contacts: dict[str, dict] = {}
    with conn() as c:
        rows = c.execute(
            "SELECT from_addr,from_name,to_addr,date,created_at FROM emails "
            "WHERE coalesce(from_addr,'')<>'' OR coalesce(to_addr,'')<>''"
        ).fetchall()
        sent_rows = c.execute(
            "SELECT to_addr,cc_addr,bcc_addr,COALESCE(sent_at,created_at) AS contact_date "
            "FROM sent_messages WHERE status IN ('sent','accepted')"
        ).fetchall()
        saved_rows = c.execute("SELECT * FROM contacts").fetchall()

    def remember(address: str, name: str = "", contact_date: str = ""):
        address = (address or "").strip().lower()
        if not address or "@" not in address or address == (config.IMAP_USER or "").strip().lower():
            return
        item = contacts.setdefault(address, {
            "id": None, "email": address, "name": "", "company": "", "note": "",
            "favorite": False, "manual": False, "count": 0, "last_contact": "",
        })
        item["count"] += 1
        if name and not item["name"] and not _contact_name_is_placeholder(name, address):
            item["name"] = name.strip(' "')
        if contact_date and contact_date > item["last_contact"]:
            item["last_contact"] = contact_date

    for row in rows:
        contact_date = row["date"] or row["created_at"] or ""
        remember(row["from_addr"], row["from_name"] or "", contact_date)
        for name, address in getaddresses([row["to_addr"] or ""]):
            remember(address, name, contact_date)
    for row in sent_rows:
        for field in ("to_addr", "cc_addr", "bcc_addr"):
            for name, address in getaddresses([row[field] or ""]):
                remember(address, name, row["contact_date"] or "")

    hidden = set()
    for row in saved_rows:
        address = row["email"].strip().lower()
        if row["hidden"]:
            hidden.add(address)
            continue
        item = contacts.setdefault(address, {
            "id": None, "email": address, "name": "", "company": "", "note": "",
            "favorite": False, "manual": False, "count": 0, "last_contact": "",
        })
        item.update({
            "id": row["id"],
            "name": row["name"] or item["name"],
            "company": row["company"] or "",
            "note": row["note"] or "",
            'group_name': row['group_name'] or '',
            "favorite": bool(row["favorite"]),
            "manual": row["source"] == "manual",
        })
    learned_names = contact_display_names(contacts.keys(), connection=None)
    for address, item in contacts.items():
        if (not item["manual"] or not str(item["name"] or "").strip()) and address in learned_names:
            item["name"] = learned_names[address]["name"]
    values = [item for address, item in contacts.items() if address not in hidden]
    if group_name:
        values = [item for item in values if (not item.get('group_name') if group_name == '__ungrouped__' else item.get('group_name') == group_name)]
    if favorites_only:
        values = [item for item in values if item["favorite"]]
    if query:
        from .pinyin_search import matches
        values = [item for item in values if matches(query, item['name'], item['email'], item['company'])]
    return sorted(values, key=lambda item: (-int(item["favorite"]), -item["count"], item["email"]))[:max(1, min(limit, 300))]


def save_contact(email: str, name: str = "", company: str = "", note: str = "",
                 favorite: bool = False) -> dict:
    """新增或更新个人联系人；历史学习到的记录会被个人资料覆盖。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,name,company,note,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,?,?,?,?,'manual',0,?,?) ON CONFLICT(email) DO UPDATE SET "
            "name=excluded.name,company=excluded.company,note=excluded.note,favorite=excluded.favorite,"
            "source='manual',hidden=0,updated_at=excluded.updated_at",
            (normalized, name.strip(), company.strip(), note.strip(), int(favorite), now, now),
        )
    return next(item for item in search_contacts(normalized, 10) if item["email"] == normalized)


def set_contact_favorite(email: str, favorite: bool) -> dict:
    """收藏历史联系人时只保存用户选择，不要求手工补齐资料。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,?,'history',0,?,?) ON CONFLICT(email) DO UPDATE SET "
            "favorite=excluded.favorite,hidden=0,updated_at=excluded.updated_at",
            (normalized, int(favorite), now, now),
        )
    return next(item for item in search_contacts(normalized, 10) if item["email"] == normalized)


def hide_contact(email: str):
    """从通讯录候选中隐藏；不删除任何邮件或往来记录。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,0,'history',1,?,?) ON CONFLICT(email) DO UPDATE SET "
            "favorite=0,hidden=1,updated_at=excluded.updated_at",
            (normalized, now, now),
        )


def contact_history(addresses: list[str]) -> dict[str, int]:
    """返回联系人在本地来往邮件中的出现次数，供发信前首次联系人提醒使用。"""
    wanted = {str(value).strip().casefold() for value in addresses if "@" in str(value)}
    counts = {value: 0 for value in wanted}
    if not wanted:
        return counts
    like_values = [f"%{value}%" for value in wanted]
    where = " OR ".join(["lower(from_addr)=?"] * len(wanted) + ["lower(to_addr) LIKE ?"] * len(wanted))
    with conn() as c:
        rows = c.execute(
            "SELECT from_addr,to_addr FROM emails WHERE remote_missing=0 "
            f"AND ({where})",
            [*wanted, *like_values],
        ).fetchall()
    for row in rows:
        sender = (row["from_addr"] or "").strip().casefold()
        if sender in counts:
            counts[sender] += 1
        for _, address in getaddresses([row["to_addr"] or ""]):
            normalized = address.strip().casefold()
            if normalized in counts:
                counts[normalized] += 1
    # 刚发出的邮件可能还没有被 IMAP 同步回来，也应计入历史联系人。
    with conn() as c:
        sent_rows = c.execute(
            "SELECT to_addr,cc_addr,bcc_addr FROM sent_messages WHERE status='sent' OR status='accepted'"
        ).fetchall()
    for row in sent_rows:
        for field in ("to_addr", "cc_addr", "bcc_addr"):
            for _, address in getaddresses([row[field] or ""]):
                normalized = address.strip().casefold()
                if normalized in counts:
                    counts[normalized] += 1
    return counts


# ---------- todos ----------

def add_todos(email_id: int, todos: list):
    with conn() as c:
        for t in todos:
            title = (t.get("title") or "").strip()
            if not title:
                continue
            c.execute(
                "INSERT INTO todos(email_id,title,deadline,status,created_at) VALUES(?,?,?,?,?)",
                (email_id, title, t.get("deadline"), "open",
                 datetime.now().isoformat(timespec="seconds")),
            )


def list_todos(include_done=False):
    sql = (
        "SELECT t.*, e.subject AS email_subject, e.from_addr AS email_from, "
        "e.date AS email_date, e.created_at AS email_indexed_at "
        "FROM todos t LEFT JOIN emails e ON e.id=t.email_id"
    )
    if not include_done:
        sql += " WHERE t.status='open'"
    # The todo center is a reading stream, not a deadline planner: keep active
    # work first, then show items from the most recently received mail first.
    # Falling back to todo creation time also keeps orphaned/legacy rows stable.
    sql += (
        " ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END, "
        "datetime(COALESCE(NULLIF(e.date,''),NULLIF(t.created_at,''))) DESC, t.id DESC"
    )
    with conn() as c:
        return [dict(r) for r in c.execute(sql).fetchall()]


def set_todo_status(todo_id: int, status: str):
    with conn() as c:
        c.execute("UPDATE todos SET status=?,user_edited=1,remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id=?", (status, status, todo_id))


def set_todos_status(todo_ids: list[int], status: str) -> int:
    ids = sorted({int(todo_id) for todo_id in todo_ids if int(todo_id) > 0})
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    with conn() as c:
        cursor = c.execute(
            f"UPDATE todos SET status=?,user_edited=1,remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id IN ({placeholders})",
            [status, status, *ids],
        )
        return cursor.rowcount


def update_todo(todo_id: int, *, title: str | None = None, deadline: str | None = None):
    sets, values = [], []
    if title is not None:
        sets.append("title=?"); values.append(title.strip())
    if deadline is not None:
        sets.append("deadline=?"); values.append(deadline or None)
    if not sets:
        return
    values.append(todo_id)
    with conn() as c:
        c.execute(f"UPDATE todos SET user_edited=1,{', '.join(sets)} WHERE id=?", values)


def refresh_generated_todos(email_id: int, todos: list):
    """Refresh machine-only suggestions without racing a user's task edits."""
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute("SELECT 1 FROM todos WHERE email_id=? AND (user_edited=1 OR status='done' OR remind_at IS NOT NULL OR stage='waiting') LIMIT 1", (email_id,)).fetchone():
            return
        c.execute('DELETE FROM todos WHERE email_id=?', (email_id,))
        for todo in todos:
            title = (todo.get('title') or '').strip()
            if title:
                c.execute("INSERT INTO todos(email_id,title,deadline,status,created_at) VALUES(?,?,?,'open',?)",(email_id,title,todo.get('deadline'),datetime.now().isoformat(timespec='seconds')))


def delete_todos_of(email_id: int):
    with conn() as c:
        c.execute("DELETE FROM todos WHERE email_id=?", (email_id,))


# ---------- threads ----------


def upsert_thread(thread_id: str, message_ids: list, participant_domains: list,
                  summary: str | None, last_email_id: int):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO threads(thread_id, message_ids, participant_domains, summary, last_email_id, updated_at) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(thread_id) DO UPDATE SET "
            "message_ids=excluded.message_ids, participant_domains=excluded.participant_domains, "
            "summary=excluded.summary, last_email_id=excluded.last_email_id, updated_at=excluded.updated_at",
            (thread_id, json.dumps(message_ids, ensure_ascii=False),
             json.dumps(participant_domains, ensure_ascii=False), summary, last_email_id, now),
        )


def get_thread(thread_id: str):
    with conn() as c:
        row = c.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        for k in ("message_ids", "participant_domains"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except (TypeError, json.JSONDecodeError):
                d[k] = []
        return d


def list_thread_emails(thread_id: str, limit: int = 10):
    with conn() as c:
        return _decode_rows(
            c.execute(
                "SELECT * FROM emails WHERE thread_id=? ORDER BY date DESC LIMIT ?",
                (thread_id, limit),
            ).fetchall()
        )


# ---------- sender_profiles ----------


def get_or_create_sender_profile(sender_key: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        row = c.execute("SELECT * FROM sender_profiles WHERE sender_key=?", (sender_key.lower(),)).fetchone()
        if row:
            d = dict(row)
            for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
                try:
                    d[k] = json.loads(d.get(k) or ("{}" if "signature" in k or "histogram" in k else "[]"))
                except (TypeError, json.JSONDecodeError):
                    d[k] = {} if "signature" in k or "histogram" in k else []
            return d
        c.execute(
            "INSERT INTO sender_profiles(sender_key, created_at, updated_at) VALUES(?,?,?)",
            (sender_key.lower(), now, now),
        )
        # 插入后直接查询，避免递归导致的事务嵌套/锁竞争
        row = c.execute("SELECT * FROM sender_profiles WHERE sender_key=?", (sender_key.lower(),)).fetchone()
        d = dict(row) if row else {"sender_key": sender_key.lower()}
        for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
            try:
                d[k] = json.loads(d.get(k) or ("{}" if "signature" in k or "histogram" in k else "[]"))
            except (TypeError, json.JSONDecodeError):
                d[k] = {} if "signature" in k or "histogram" in k else []
        return d


def update_sender_profile(profile: dict):
    now = datetime.now().isoformat(timespec="seconds")
    profile = dict(profile)
    for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
        if not isinstance(profile.get(k), str):
            profile[k] = json.dumps(profile.get(k) or ({} if "signature" in k or "histogram" in k else []), ensure_ascii=False)
    with conn() as c:
        c.execute(
            "UPDATE sender_profiles SET "
            "from_domain=?, first_seen=?, last_seen=?, message_count=?, internal_count=?, "
            "external_count=?, hour_histogram=?, attachment_names=?, attachment_types=?, "
            "typical_categories=?, avg_body_length=?, linguistic_signature=?, risk_score=?, updated_at=? "
            "WHERE sender_key=?",
            (profile.get("from_domain"), profile.get("first_seen"), profile.get("last_seen"),
             profile.get("message_count", 0), profile.get("internal_count", 0),
             profile.get("external_count", 0), profile.get("hour_histogram"),
             profile.get("attachment_names"), profile.get("attachment_types"),
             profile.get("typical_categories"), profile.get("avg_body_length", 0),
             profile.get("linguistic_signature"), profile.get("risk_score", 0), now,
             profile["sender_key"].lower()),
        )


def sender_risk_top(n: int = 5):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM sender_profiles ORDER BY risk_score DESC, message_count DESC LIMIT ?",
            (n,),
        ).fetchall()]


# ---------- audit_logs ----------


def add_audit_log(email_id: int | None, action: str, old_status: str | None = None,
                  new_status: str | None = None, actor: str = "system",
                  reason: str = "", meta: dict | None = None):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO audit_logs(email_id, action, old_status, new_status, actor, reason, meta, created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (email_id, action, old_status, new_status, actor, reason,
             json.dumps(meta or {}, ensure_ascii=False), now),
        )


def list_audit_logs(email_id: int | None = None, limit: int = 100):
    sql = "SELECT * FROM audit_logs"
    args = []
    if email_id is not None:
        sql += " WHERE email_id=?"
        args.append(email_id)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
        for r in rows:
            try:
                r["meta"] = json.loads(r.get("meta") or "{}")
            except (TypeError, json.JSONDecodeError):
                r["meta"] = {}
        return rows


def list_auto_action_candidates(limit: int = 10):
    """返回仍处于自动移动目标文件夹、可安全回滚的最近邮件。"""
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM emails "
            "WHERE action_mode='auto' AND action_taken=1 "
            "AND status IN ('quarantine','spam') "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (max(1, min(int(limit), 50)),),
        ).fetchall()]


# ---------- rule/runtime settings ----------

def list_rule_settings():
    with conn() as c:
        return {r["code"]: dict(r) for r in c.execute("SELECT * FROM rule_settings").fetchall()}


def set_rule_setting(code: str, enabled: bool, weight: int):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO rule_settings(code,enabled,weight,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,weight=excluded.weight,updated_at=excluded.updated_at",
            (code, 1 if enabled else 0, weight, now),
        )


def delete_rule_settings():
    with conn() as c:
        c.execute("DELETE FROM rule_settings")


def list_security_allowlist():
    with conn() as c:
        domains = [dict(r) | {"kind": "domain", "value": r["domain"]} for r in c.execute(
            "SELECT id,domain,enabled,note,created_at,updated_at "
            "FROM security_allowlist ORDER BY enabled DESC, domain ASC"
        ).fetchall()]
        addresses = [dict(r) | {"kind": "address", "value": r["email"]} for r in c.execute(
            "SELECT id,email,enabled,note,created_at,updated_at "
            "FROM security_allowlist_addresses ORDER BY enabled DESC, email ASC"
        ).fetchall()]
        return sorted(domains + addresses, key=lambda item: (not bool(item["enabled"]), item["value"]))


def upsert_security_allowlist(domain: str, enabled: bool = True, note: str = ""):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO security_allowlist(domain,enabled,note,created_at,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(domain) DO UPDATE SET enabled=excluded.enabled,note=excluded.note,updated_at=excluded.updated_at",
            (domain, 1 if enabled else 0, note, now, now),
        )
        row = c.execute("SELECT * FROM security_allowlist WHERE domain=?", (domain,)).fetchone()
        return dict(row)


def delete_security_allowlist(entry_id: int) -> bool:
    with conn() as c:
        cursor = c.execute("DELETE FROM security_allowlist WHERE id=?", (entry_id,))
        return cursor.rowcount > 0


def upsert_security_allowlist_address(email: str, enabled: bool = True, note: str = ""):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO security_allowlist_addresses(email,enabled,note,created_at,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(email) DO UPDATE SET enabled=excluded.enabled,note=excluded.note,updated_at=excluded.updated_at",
            (email, 1 if enabled else 0, note, now, now),
        )
        row = c.execute("SELECT * FROM security_allowlist_addresses WHERE email=?", (email,)).fetchone()
        return dict(row) | {"kind": "address", "value": row["email"]}


def delete_security_allowlist_address(entry_id: int) -> bool:
    with conn() as c:
        cursor = c.execute("DELETE FROM security_allowlist_addresses WHERE id=?", (entry_id,))
        return cursor.rowcount > 0


def set_rule_settings(items: list[tuple[str, bool, int]]):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.executemany(
            "INSERT INTO rule_settings(code,enabled,weight,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,weight=excluded.weight,updated_at=excluded.updated_at",
            [(code, 1 if enabled else 0, weight, now) for code, enabled, weight in items],
        )


def get_runtime_settings():
    with conn() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key,value FROM runtime_settings").fetchall()}


def set_runtime_setting(key: str, value: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO runtime_settings(key,value,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            (key, value, now),
        )


# ---------- url_chains ----------


def save_url_chain(email_id: int, original_url: str, chain: list, final_url: str | None,
                   final_domain: str | None, final_ip: str | None, landing_status: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO url_chains(email_id, original_url, chain, final_url, final_domain, final_ip, landing_status, created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (email_id, original_url, json.dumps(chain, ensure_ascii=False), final_url,
             final_domain, final_ip, landing_status, now),
        )


def get_url_chains(email_id: int):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM url_chains WHERE email_id=? ORDER BY id", (email_id,)
        ).fetchall()]
        for r in rows:
            try:
                r["chain"] = json.loads(r.get("chain") or "[]")
            except (TypeError, json.JSONDecodeError):
                r["chain"] = []
        return rows


# ---------- metrics ----------


def stats_range(days: int = 7):
    with conn() as c:
        def n(where=""):
            return c.execute(
                f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND "
                f"datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?) {where}",
                (f"-{days} days",),
            ).fetchone()["n"]

        total = n()
        phishing = n("AND verdict='phishing'")
        suspicious = n("AND verdict='suspicious'")
        spam = n("AND verdict='clean' AND status='spam'")
        quarantine = n("AND status='quarantine'")
        clean = n("AND verdict='clean' AND status='inbox'")
        false_positives = n("AND feedback='fp'")
        false_negatives = n("AND feedback='fn'")

        avg_handle = c.execute(
            "SELECT AVG((julianday(created_at) - julianday(date)) * 86400) AS v "
            "FROM emails WHERE created_at >= datetime('now','localtime', ?) AND date IS NOT NULL",
            (f"-{days} days",),
        ).fetchone()["v"] or 0

        return {
            "total": total,
            "phishing": phishing,
            "suspicious": suspicious,
            "spam": spam,
            "quarantine": quarantine,
            "clean": clean,
            "false_positives": false_positives,
            "false_negatives": false_negatives,
            "avg_handle_seconds": round(avg_handle, 2),
            "saved_hours": round((phishing + spam) * 3 / 60, 2),
        }


def daily_trend(days: int = 7):
    with conn() as c:
        rows = c.execute(
            "SELECT date(COALESCE(NULLIF(date,''),created_at)) AS d, verdict, COUNT(*) AS n "
            "FROM emails WHERE remote_missing=0 AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?) "
            "GROUP BY date(COALESCE(NULLIF(date,''),created_at)), verdict",
            (f"-{days} days",),
        ).fetchall()
    trend = {}
    for r in rows:
        trend.setdefault(r["d"], {})[r["verdict"] or "clean"] = r["n"]
    return trend


def dashboard_operations(days: int = 7):
    """Return decision-oriented security operations data for the dashboard."""
    days = max(1, min(int(days), 90))
    current_window = f"-{days} days"
    previous_window = f"-{days * 2} days"
    risk_where = "verdict IN ('phishing','suspicious')"
    with conn() as c:
        def scalar(sql, args=()):
            row = c.execute(sql, args).fetchone()
            return int(row["n"] or 0)

        dated = "datetime(COALESCE(NULLIF(date,''),created_at))"
        current_total = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        current_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        previous_total = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {dated} >= datetime('now','localtime', ?) AND {dated} < datetime('now','localtime', ?)",
            (previous_window, current_window),
        )
        previous_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?) AND {dated} < datetime('now','localtime', ?)",
            (previous_window, current_window),
        )
        pending_review = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            "AND reviewed=0 AND COALESCE(feedback,'')=''"
        )
        pending_period = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND reviewed=0 AND COALESCE(feedback,'')='' AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        auto_handled = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND action_taken=1 AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        resolved_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND (reviewed=1 OR COALESCE(feedback,'')<>'') AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        feedback_count = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND COALESCE(feedback,'')<>'' AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        today_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND date(COALESCE(NULLIF(date,''),created_at))=date('now','localtime')"
        )
        attention = [dict(r) for r in c.execute(
            "SELECT id,subject,from_addr,from_name,date,created_at,score,verdict,status,action_taken "
            f"FROM emails WHERE remote_missing=0 AND {risk_where} AND reviewed=0 AND COALESCE(feedback,'')='' "
            "ORDER BY score DESC, datetime(COALESCE(NULLIF(date,''),created_at)) DESC LIMIT 6"
        ).fetchall()]
        risky_senders = [dict(r) for r in c.execute(
            "SELECT lower(COALESCE(NULLIF(from_addr,''),'未知发件人')) AS sender, MAX(id) AS email_id, COUNT(*) AS risk_count, "
            "MAX(score) AS max_score, SUM(CASE WHEN verdict='phishing' THEN 1 ELSE 0 END) AS phishing_count "
            f"FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?) "
            "GROUP BY lower(COALESCE(NULLIF(from_addr,''),'未知发件人')) "
            "ORDER BY risk_count DESC, max_score DESC LIMIT 5",
            (current_window,),
        ).fetchall()]

    current_rate = current_risk * 100 / current_total if current_total else 0.0
    previous_rate = previous_risk * 100 / previous_total if previous_total else 0.0
    return {
        "pending_review": pending_review,
        "pending_period": pending_period,
        "today_risk": today_risk,
        "risk_count": current_risk,
        "risk_rate": round(current_rate, 1),
        "risk_rate_delta": round(current_rate - previous_rate, 1),
        "auto_handled": auto_handled,
        "resolved_risk": resolved_risk,
        "feedback_count": feedback_count,
        "attention": attention,
        "risky_senders": risky_senders,
    }


# ---------- feedback ----------


def record_feedback(email_id: int, feedback: str, note: str = ""):
    with conn() as c:
        c.execute("UPDATE emails SET feedback=?, feedback_note=? WHERE id=?",
                  (feedback, note, email_id))


# ---------- digest history ----------


def save_digest(content: str, digest_date: str | None = None):
    now = datetime.now().isoformat(timespec="seconds")
    if digest_date is None:
        digest_date = now[:10]
    with conn() as c:
        cur = c.execute(
            "INSERT INTO digest_history(digest_date, content, created_at) VALUES(?,?,?)",
            (digest_date, content, now),
        )
        return cur.lastrowid


def list_digests(limit: int = 30):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, digest_date, created_at FROM digest_history ORDER BY digest_date DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()]


def get_digest(digest_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM digest_history WHERE id=?", (digest_id,)).fetchone()
        return dict(row) if row else None


def list_contact_groups():
    with conn() as c:
        return [dict(row) for row in c.execute("SELECT g.name,COUNT(c.id) AS count FROM contact_groups g LEFT JOIN contacts c ON c.group_name=g.name AND c.hidden=0 GROUP BY g.name ORDER BY g.name")]


def save_contact_group(name, previous=None):
    name = str(name or '').strip()
    if not name or len(name) > 80:
        raise ValueError('分组名称不能为空，且不能超过 80 字')
    with conn() as c:
        if previous is not None and not c.execute('SELECT 1 FROM contact_groups WHERE name=?', (previous,)).fetchone():
            raise ValueError('分组不存在，请刷新后重试')
        if name != previous and c.execute('SELECT 1 FROM contact_groups WHERE name=?', (name,)).fetchone():
            raise ValueError('分组名称已存在')
        if previous is None:
            c.execute('INSERT INTO contact_groups(name) VALUES(?)', (name,))
        else:
            c.execute('UPDATE contact_groups SET name=? WHERE name=?', (name, previous))
            c.execute('UPDATE contacts SET group_name=? WHERE group_name=?', (name, previous))
    return {'ok': True, 'name': name}


def delete_contact_group(name):
    with conn() as c:
        c.execute("UPDATE contacts SET group_name='' WHERE group_name=?", (name,))
        c.execute('DELETE FROM contact_groups WHERE name=?', (name,))
    return {'ok': True}


def update_contact_group_members(name, emails, *, remove=False):
    """Change group membership without overwriting personal contact details."""
    addresses = list(dict.fromkeys(str(email).strip().lower() for email in emails))
    if not addresses or len(addresses) > 300:
        raise ValueError('每次请选择 1 至 300 位联系人')
    learned = {}
    if not remove:
        for address in addresses:
            matches = search_contacts(address, 300)
            item = next((item for item in matches if item['email'] == address), None)
            if not item:
                raise ValueError('所选联系人已不存在，请刷新后重新选择')
            learned[address] = item
    now = datetime.now().isoformat(timespec='seconds')
    with conn() as c:
        if not c.execute('SELECT 1 FROM contact_groups WHERE name=?', (name,)).fetchone():
            raise ValueError('分组不存在，请刷新后重试')
        for address in addresses:
            if remove:
                c.execute("UPDATE contacts SET group_name='',updated_at=? WHERE email=? AND group_name=?", (now, address, name))
            else:
                c.execute("INSERT INTO contacts(email,name,group_name,source,created_at,updated_at) VALUES(?,?,?,'history',?,?) ON CONFLICT(email) DO UPDATE SET group_name=excluded.group_name,updated_at=excluded.updated_at",
                          (address, learned[address]['name'], name, now, now))
    return {'ok': True, 'count': len(addresses)}


def _merge_legacy_cleanup_archives(c):
    """Restore legacy cleanup copies to their original records, idempotently.

    Leave copies on disk and old IDs readable; only retire their duplicate list
    entries once their original record has been positively identified.
    """
    import os
    for job in c.execute("SELECT token,payload,result FROM server_cleanup_jobs WHERE status<>'preview'").fetchall():
        try:
            payload, result = json.loads(job['payload']), json.loads(job['result'])
        except (ValueError, TypeError):
            continue
        planned = {item['id']: item for item in payload.get('items', [])}
        for item in result.get('items', []):
            if not item.get('archive_id') or item['archive_id'] == item.get('id'):
                continue
            archive = c.execute("SELECT * FROM emails WHERE id=? AND status='local_archive' AND is_local_archive=1", (item['archive_id'],)).fetchone()
            original = c.execute('SELECT * FROM emails WHERE id=?', (item.get('id'),)).fetchone()
            plan = planned.get(item.get('id'))
            if (not archive or not original or not plan or original['folder'] != payload.get('folder')
                    or original['uid'] not in (plan['uid'], -original['id'])
                    or original['message_id'] != archive['message_id']
                    or (not original['message_id'] and any(original[key] != archive[key] for key in ('subject','from_addr','date')))):
                continue
            raw_path = archive['raw_path']
            if not raw_path or not os.path.isfile(raw_path):
                continue
            # Preserve edits made to the visible legacy copy, including favorites.
            retained = item.get('status') in ('deleted', 'uncertain') or bool(original['cleanup_hold'])
            c.execute('UPDATE emails SET uid=?,is_local_archive=?,remote_missing=0,raw_path=?,is_read=?,is_favorite=?,is_starred=? WHERE id=?',
                      (-original['id'] if retained else original['uid'], int(retained), raw_path, archive['is_read'],
                       int(bool(original['is_favorite'] or archive['is_favorite'])), archive['is_starred'], original['id']))
            c.execute("UPDATE emails SET remote_missing=1,status='local_archive_merged' WHERE id=?", (archive['id'],))
            c.execute('DELETE FROM seen_sync_jobs WHERE email_id IN (?,?)', (original['id'], archive['id']))
