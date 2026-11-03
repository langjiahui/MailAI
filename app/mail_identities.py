"""Recover legacy display metadata outside foreground mailbox reads."""
import hashlib
import json
import logging
import threading
import time

from . import config

log = logging.getLogger(__name__)
_pending = set()
_completed = {}
_lock = threading.Lock()
FIELDS = ('raw_path', 'from_addr', 'from_name', 'to_addr', 'cc_addr', 'recipient_names', 'remote_missing')


def fingerprint(row):
    return hashlib.sha256(json.dumps([row[field] for field in FIELDS], ensure_ascii=True).encode()).hexdigest()


def initialize(c):
    c.execute('CREATE TABLE IF NOT EXISTS mail_identity_revision(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)')
    c.execute('INSERT OR IGNORE INTO mail_identity_revision VALUES(1,0)')
    c.execute("CREATE TABLE IF NOT EXISTS mail_identity_cache(email_id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,sender_name TEXT NOT NULL,recipient_names TEXT NOT NULL)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_mail_identity_pending ON emails(id) WHERE remote_missing=0 AND coalesce(raw_path,'')<>''")
    for action in ('INSERT', 'DELETE', 'UPDATE OF ' + ','.join(FIELDS)):
        suffix = action.split()[0].lower()
        deleted = 'OLD' if suffix == 'delete' else 'NEW'
        c.execute(f'''CREATE TRIGGER IF NOT EXISTS mail_identity_{suffix} AFTER {action} ON emails BEGIN
            DELETE FROM mail_identity_cache WHERE email_id={deleted}.id;
            UPDATE mail_identity_revision SET value=value+1 WHERE id=1; END''')
    for action in ('INSERT', 'UPDATE'):
        c.execute(f'''CREATE TRIGGER IF NOT EXISTS mail_identity_cache_{action.lower()} AFTER {action} ON mail_identity_cache BEGIN
            UPDATE mail_identity_revision SET value=value+1 WHERE id=1;
            UPDATE mailbox_sequence SET value=value+1 WHERE id=1; END''')


def repair():
    from . import db, parser
    from .mail_headers import damaged_display_name
    while True:
        with db.conn() as c:
            c.execute('BEGIN')
            rows = c.execute('SELECT e.id,' + ','.join('e.' + field for field in FIELDS) + ''' FROM emails e
                LEFT JOIN mail_identity_cache i ON i.email_id=e.id
                WHERE e.remote_missing=0 AND i.email_id IS NULL AND coalesce(e.raw_path,'')<>''
                ORDER BY e.id LIMIT 50''').fetchall()
            revision = c.execute('SELECT value FROM mail_identity_revision WHERE id=1').fetchone()[0]
        if not rows:
            return revision
        recovered = []
        for row in rows:
            try:
                pairs = json.loads(row['recipient_names'] or '{}')
            except (ValueError, TypeError):
                pairs = {}
            pairs = pairs if isinstance(pairs, dict) else {}
            sender = row['from_name'] or ''
            # Read only bounded headers; normal metadata needs no original I/O.
            try:
                if not pairs or any(damaged_display_name(value) for value in pairs.values()):
                    original = parser.recipient_names_from_raw_path(row['raw_path'])
                    for address, name in original.items():
                        if not pairs.get(address) or damaged_display_name(pairs[address]):
                            pairs[address] = name
                if damaged_display_name(sender):
                    sender = parser.sender_name_from_raw_path(row['raw_path'], row['from_addr'] or '') or sender
            except Exception as exc:
                # A malformed original cannot stall every later mailbox read.
                log.warning('Legacy identity header recovery failed: %s', type(exc).__name__)
            recovered.append((row['id'], fingerprint(row), sender, json.dumps(pairs, ensure_ascii=False)))
        with db.conn() as c:
            for email_id, stamp, sender, pairs in recovered:
                current = c.execute('SELECT ' + ','.join(FIELDS) + ' FROM emails WHERE id=?', (email_id,)).fetchone()
                if current is not None and fingerprint(current) == stamp:
                    c.execute('INSERT OR IGNORE INTO mail_identity_cache VALUES(?,?,?,?)', (email_id, stamp, sender, pairs))
        time.sleep(.02)


def schedule():
    key = config.DB_PATH
    from . import db
    with db.conn() as c:
        c.execute('BEGIN')
        revision = c.execute('SELECT value FROM mail_identity_revision WHERE id=1').fetchone()[0]
        with _lock:
            if key in _pending or _completed.get(key) == revision:
                return
        needed = c.execute("SELECT 1 FROM emails e LEFT JOIN mail_identity_cache i ON i.email_id=e.id WHERE e.remote_missing=0 AND i.email_id IS NULL AND coalesce(e.raw_path,'')<>'' LIMIT 1").fetchone()
    with _lock:
        if key in _pending or _completed.get(key) == revision:
            return
        if not needed:
            _completed[key] = revision
            return
        _pending.add(key)
    from .account_context import current, use
    values = dict(current.get() or {})
    values.update(DB_PATH=key, RAW_DIR=config.RAW_DIR, IMAP_USER=config.IMAP_USER)
    values.setdefault('ACCOUNT_ID', 'identity:' + hashlib.sha256(key.encode()).hexdigest()[:24])
    def run():
        try:
            with use(values):
                completed = repair()
                with _lock:
                    _completed[key] = completed
                    while len(_completed)>64:
                        _completed.pop(next(iter(_completed)))
        except Exception:
            log.exception('Legacy identity background recovery failed')
        finally:
            with _lock:
                _pending.discard(key)
    try:
        from .account_guard import start_account_thread
        start_account_thread(run, name='mailai-mail-identities')
    except BaseException:
        with _lock:
            _pending.discard(key)
        raise
