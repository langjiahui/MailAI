"""连接管理、Schema 与迁移。每个操作独立连接，线程安全。"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from .. import config

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
    from ..mail_search import register
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
        from ..mail_search import initialize
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
        "notification_sent": "INTEGER NOT NULL DEFAULT 0",
    }
    for col, dtype in new_email_cols.items():
        if col not in emails_cols:
            c.execute(f"ALTER TABLE emails ADD COLUMN {col} {dtype}")
            if col == 'notification_sent':
                c.execute('UPDATE emails SET notification_sent=1')
    if 'alert_email_ids' not in _columns_of(c, 'assistant_conversations'):
        c.execute("ALTER TABLE assistant_conversations ADD COLUMN alert_email_ids TEXT DEFAULT '[]'")
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
