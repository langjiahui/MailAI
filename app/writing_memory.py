"""Optional account-local learning from confirmed outbound messages."""

from collections import Counter, defaultdict
from contextlib import closing, contextmanager, nullcontext
from datetime import datetime, timedelta
import hashlib
import json
import logging
from pathlib import Path
import re
import sqlite3
from time import monotonic
from uuid import uuid4

from . import config, db, parser, writing_style as style

log = logging.getLogger(__name__)
BATCH = 16
MIN_BATCH = 4
SLOW_BATCH_SECONDS = .12
FAST_BATCH_SECONDS = .06
RECOVERY_BATCHES = 3
HISTORY_DAYS = (30, 90, 180)
_AUTO_SUBJECT = re.compile(r'^(?:自动回复|自动通知|外出回复|退信|automatic reply|auto.?reply|out of office|delivery status notification)', re.I)
_FIELDS = dict(local='sent_messages', server='emails')
_DATES = dict(local='sent_at', server='date')
_ELIGIBLE = dict(local="status IN ('sent','accepted')", server="status='sent' AND remote_missing=0")
_SERVER_FILTER = "is_local_archive=0 AND pending_action='' AND is_automated=0 AND list_unsubscribe=''"
_LOCAL_AVAILABLE = (
    "m.status IN ('sent','accepted') AND (m.message_id IS NULL OR trim(m.message_id)='' OR NOT EXISTS ("
    "SELECT 1 FROM emails e WHERE lower(e.message_id) IN (lower(trim(m.message_id)), "
    "'<' || lower(trim(m.message_id,'<> ')) || '>') AND (e.status='trash' OR e.pending_action LIKE 'trash%')))"
)
_WEAK_BODY, _WEAK_SUBJECT = 1, 2
_account_cursor = 0
_batch_limits = {}
_PROMPT = {
    'length': {'short': '简短、保留行动项', 'medium': '篇幅适中', 'long': '交代完整背景与步骤'},
    'opening': {'conclusion': '结论放在正文开头'},
    'tone': {'formal': '自然得体的正式语气', 'friendly': '自然友好的语气'},
    'structure': {'list': '多个并列事项用列表写清楚'},
    'subject': {'action': '新写时在主题中写清希望对方采取的动作'},
}


def initialize(c):
    from .recipient_profiles import ensure_tables
    ensure_tables(c)
    c.execute('''CREATE TABLE IF NOT EXISTS writing_memory_state (
        id INTEGER PRIMARY KEY CHECK(id=1), collect INTEGER NOT NULL DEFAULT 0,
        since TEXT NOT NULL DEFAULT '', epoch TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
        local_floor INTEGER NOT NULL DEFAULT 0, server_floor INTEGER NOT NULL DEFAULT 0)''')
    c.execute('INSERT OR IGNORE INTO writing_memory_state(id) VALUES(1)')
    c.execute('''CREATE TABLE IF NOT EXISTS writing_memory_samples (
        source TEXT NOT NULL, source_id INTEGER NOT NULL, message_key TEXT, thread_key TEXT,
        recipient TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', scene TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL, features TEXT NOT NULL DEFAULT '{}', edits TEXT NOT NULL DEFAULT '{}',
        weak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source,source_id), UNIQUE(message_key))''')
    c.execute('''CREATE INDEX IF NOT EXISTS idx_writing_samples_match
        ON writing_memory_samples(scene,sent_at DESC) WHERE message_key IS NOT NULL''')
    for field in ('recipient', 'role'):
        c.execute(f'''CREATE INDEX IF NOT EXISTS idx_writing_samples_by_{field}
            ON writing_memory_samples(scene,{field},sent_at DESC) WHERE message_key IS NOT NULL''')
    c.execute('''CREATE TABLE IF NOT EXISTS writing_memory_rules (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, target TEXT NOT NULL, scene TEXT NOT NULL, field TEXT NOT NULL,
        value TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'adopted', evidence TEXT NOT NULL DEFAULT '{}',
        edited INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(scope,target,scene,field))''')
    c.execute("UPDATE writing_memory_rules SET status='adopted',revision=revision+1 WHERE status='pending'")
    c.execute('''CREATE INDEX IF NOT EXISTS idx_writing_sent_date ON sent_messages(sent_at,id)
        WHERE status IN ('sent','accepted')''')
    c.execute('''CREATE INDEX IF NOT EXISTS idx_writing_remote_date ON emails(date,id)
        WHERE status='sent' AND remote_missing=0''')
    for table in ('drafts', 'sent_messages'):
        c.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_writing_baseline ON {table}(id) WHERE writing_sample<>''")
    columns = {row['name'] for row in c.execute('PRAGMA table_info(writing_memory_state)')}
    if 'observed' not in columns:
        c.execute('ALTER TABLE writing_memory_state ADD COLUMN observed INTEGER NOT NULL DEFAULT 0')
        c.execute('UPDATE writing_memory_state SET observed=(SELECT COUNT(*) FROM writing_memory_samples WHERE message_key IS NOT NULL)')
    if 'batch_version' not in columns:
        c.execute('ALTER TABLE writing_memory_state ADD COLUMN batch_version INTEGER NOT NULL DEFAULT 0')
    c.execute('''CREATE TABLE IF NOT EXISTS writing_memory_cursor (
        source TEXT PRIMARY KEY, before_date TEXT, before_id INTEGER, done INTEGER NOT NULL DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS writing_memory_queue (
        source TEXT NOT NULL, source_id INTEGER NOT NULL, PRIMARY KEY(source,source_id)) WITHOUT ROWID''')
    for source, table in _FIELDS.items():
        date = _DATES[source]
        if source == 'local':
            new = "NEW.status IN ('sent','accepted')"
            old = "OLD.status IN ('sent','accepted')"
            changes = f'status,{date}'
        else:
            new = "NEW.status='sent' AND NEW.remote_missing=0 AND NEW.is_local_archive=0 AND NEW.pending_action=''"
            old = "OLD.status='sent' AND OLD.remote_missing=0 AND OLD.is_local_archive=0 AND OLD.pending_action=''"
            changes = f'status,remote_missing,is_local_archive,pending_action,{date}'
        for event, when in [('INSERT', ''), (f'UPDATE OF {changes}', f'AND (NOT COALESCE(({old}),0) OR NEW.{date} IS NOT OLD.{date})')]:
            suffix = event.split()[0].lower()
            c.execute(f'''CREATE TRIGGER IF NOT EXISTS writing_memory_{source}_{suffix} AFTER {event} ON {table}
                WHEN ({new}) AND NEW.{date} IS NOT NULL {when}
                BEGIN
                    INSERT OR IGNORE INTO writing_memory_queue(source,source_id)
                    SELECT '{source}',NEW.id FROM writing_memory_state
                    WHERE id=1 AND since<>'' AND NEW.{date}>=since AND NEW.id>{source}_floor;
                END''')


def _state(c):
    return c.execute('''SELECT s.*,m.enabled,m.revision AS memory_revision FROM writing_memory_state s
        CROSS JOIN work_learning_state m WHERE s.id=1 AND m.id=1''').fetchone()


def _public_settings(state):
    return dict(collect=bool(state['collect']), initialized=bool(state['since']), enabled=bool(state['enabled']), revision=state['revision'])


def configure(collect, days, revision):
    if days not in HISTORY_DAYS:
        return None
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        state = _state(c)
        if state['revision'] != revision or collect and not state['enabled']:
            return None
        since = state['since'] or ((datetime.now() - timedelta(days=days)).date().isoformat() if collect else '')
        c.execute('UPDATE writing_memory_state SET collect=?,since=?,epoch=?,revision=revision+1 WHERE id=1',
                  (collect, since, uuid4().hex))
        if not collect:
            _drop_baselines(c)
        return _public_settings(_state(c))


def _drop_baselines(c):
    for table in ('drafts', 'sent_messages'):
        c.execute(f"UPDATE {table} SET writing_sample='' WHERE writing_sample<>''")


def clear(revision):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if _state(c)['revision'] != revision:
            return None
        c.execute('DELETE FROM writing_memory_rules')
        c.execute('DELETE FROM writing_memory_samples')
        c.execute('DELETE FROM writing_memory_queue')
        c.executemany('''INSERT INTO writing_memory_cursor(source,done) VALUES(?,1)
            ON CONFLICT(source) DO UPDATE SET done=1''', ((source,) for source in _FIELDS))
        _drop_baselines(c)
        c.execute('''UPDATE writing_memory_state SET since=?,epoch=?,revision=revision+1,observed=0,
            local_floor=(SELECT COALESCE(MAX(id),0) FROM sent_messages),
            server_floor=(SELECT COALESCE(MAX(id),0) FROM emails) WHERE id=1''',
                  (datetime.now().isoformat(timespec='seconds'), uuid4().hex))
        return _public_settings(_state(c))


def epoch():
    try:
        with _connection() as c:
            state = _state(c)
            return state['epoch'] if state['collect'] and state['enabled'] else ''
    except sqlite3.Error:
        return ''


def encode_baseline(c, sample):
    fields = style.clean_baseline(sample)
    if not fields:
        return ''
    try:
        state = _state(c)
    except sqlite3.Error:
        return ''
    if not state['collect'] or not state['enabled']:
        return ''
    current = {key: item for key, item in fields.items() if item['epoch'] == state['epoch']}
    return json.dumps(current, ensure_ascii=False) if current else ''


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _thread_key(c, row, message_id):
    root = parser._first_msgid(row.get('references_header'))
    parent = parser._first_msgid(row.get('in_reply_to'))
    if not root and parent:
        previous = c.execute('''SELECT references_header,in_reply_to FROM emails WHERE lower(message_id) IN (?,?) LIMIT 1''',
            (parent, parent.strip('<>'))).fetchone()
        root = parser._first_msgid(previous['references_header'] or previous['in_reply_to']) if previous else ''
    return _digest((root or parent).strip('<>') or message_id)


def _batch_ids(c, source, since, budget=BATCH):
    queued = [row[0] for row in c.execute('''SELECT source_id FROM writing_memory_queue
        WHERE source=? ORDER BY source_id LIMIT ?''', (source, budget))]
    cursor = c.execute('SELECT before_date,before_id,done FROM writing_memory_cursor WHERE source=?', (source,)).fetchone()
    if cursor and cursor['done']:
        return queued, queued, None
    table, date = _FIELDS[source], _DATES[source]
    limit = budget - min(len(queued), budget // 2)
    # Limit index entries before filtering processed IDs or loading message text.
    query = f'SELECT id,{date} FROM {table} WHERE {_ELIGIBLE[source]} AND {date}>=?'
    order = f'ORDER BY {date} DESC,id DESC LIMIT ?'
    if cursor and cursor['before_date'] is not None:
        # SQLite can scan a whole timestamp tie for a row-value comparison on
        # an INTEGER PRIMARY KEY. Seek within the tie and then to older dates.
        boundary = cursor['before_date']
        rows = c.execute(f'{query} AND {date}=? AND id<? {order}', (since,boundary,cursor['before_id'],limit)).fetchall()
        if len(rows) < limit:
            rows.extend(c.execute(f'{query} AND {date}<? {order}', (since,boundary,limit-len(rows))))
    else:
        rows = c.execute(f'{query} {order}', (since,limit)).fetchall()
    queued = queued[:budget - len(rows)]
    ids = list(dict.fromkeys(queued + [row[0] for row in rows]))
    checkpoint = (rows[-1][1], rows[-1][0], len(rows) < limit) if rows else (None, None, True)
    return ids, queued, checkpoint


def _source_rows(c, source, state, since, ids):
    if not ids:
        return []
    table, date = _FIELDS[source], _DATES[source]
    if source == 'local':
        fields = "m.reply_to_email_id,m.bcc_addr,substr(m.writing_sample,1,16000) writing_sample,m.smtp_response,m.writing_scene"
    else:
        fields = "m.raw_path,substr(m.body_text,1,6000) body_text"
    where = _ELIGIBLE[source] + (f' AND {_SERVER_FILTER}' if source == 'server' else '')
    values = ','.join('?' for _ in ids)
    return [dict(row) for row in c.execute(f'''SELECT m.id,m.message_id,m.from_addr,m.to_addr,m.cc_addr,
        m.subject,m.{date} sent_at,m.in_reply_to,m.references_header,substr(m.body_html,1,12000) body_html,{fields}
        FROM {table} m NOT INDEXED WHERE m.id IN ({values}) AND {where} AND m.{date}>=? AND m.id>?
        AND NOT EXISTS(SELECT 1 FROM writing_memory_samples s WHERE s.source=? AND s.source_id=m.id)
        ORDER BY m.{date} DESC,m.id DESC''', (*ids, since, state[source + '_floor'], source))]


def _observations(c, rows, state, source):
    owner = style.addresses(config.IMAP_USER)
    observations = []
    for row in rows:
        empty = dict(source=source, source_id=row['id'], sent_at=row['sent_at'])
        observations.append(empty)
        # Never learn from a partially accepted envelope or a hidden/Bcc-only audience.
        if row.get('smtp_response') == 'partially accepted' or _AUTO_SUBJECT.search(row['subject'] or ''):
            continue
        if not owner or style.addresses(row['from_addr']) != owner:
            continue
        message_id = (row['message_id'] or '').strip().strip('<>').casefold()
        if source == 'server' and message_id and c.execute('''SELECT 1 FROM sent_messages WHERE lower(message_id) IN (?,?) LIMIT 1''',
            ('<' + message_id + '>', message_id)).fetchone():
            continue
        if source == 'local':
            scene = row['writing_scene'] or style.scene_for(row)
        else:
            scene = style.scene_for(row)
            raw_path = row['raw_path']
            if raw_path and Path(raw_path).is_file():
                try:
                    headers = parser._read_raw_headers(raw_path, max_bytes=64 * 1024, require_complete=True)
                    if (headers.get('Auto-Submitted', 'no').lower() != 'no' or headers.get('List-Id')
                            or headers.get('Precedence', '').lower() in ('bulk', 'list', 'junk')):
                        continue
                    row['bcc_addr'] = ','.join(addr for _, addr in parser.address_header_pairs(headers, 'Bcc'))
                except (OSError, ValueError):
                    continue
        if scene not in ('compose', 'reply'):
            continue
        to, cc, bcc = target = style.audience(row)
        if not to or len(set(to + cc + bcc)) > 5 or bcc:
            continue
        if source == 'local' and message_id and c.execute('''SELECT 1 FROM emails WHERE lower(message_id) IN (?,?)
            AND (status='trash' OR pending_action LIKE 'trash%') LIMIT 1''', ('<' + message_id + '>', message_id)).fetchone():
            continue
        text = style.authored_text(row)
        subject = (row['subject'] or '').strip()[:300]
        features = style.features(text, subject)
        if not features:
            continue
        # Without an RFC identity, identical duplicates on the same send day
        # contribute one sample, even if a client wrote multiple server copies.
        message_id = message_id or _digest(json.dumps([owner, target, row['sent_at'][:10], subject, text]))
        recipient = to[0] if len(to) == 1 and not cc and to != owner else ''
        profile = c.execute('SELECT role_key FROM contact_communication_profiles WHERE email=?', (recipient,)).fetchone() if recipient else None
        edits, weak = {}, 0
        if source == 'local' and row['writing_sample']:
            try:
                baseline = style.clean_baseline(json.loads(row['writing_sample']))
                edits = style.edited_signals(baseline, text, subject, target, state['epoch'])
                for field, flag in (('body', _WEAK_BODY), ('subject', _WEAK_SUBJECT)):
                    part = baseline.get(field)
                    changed = bool(edits.keys() - {'subject'}) if field == 'body' else 'subject' in edits
                    if part and part['epoch'] == state['epoch'] and part['audience'] == target and not changed:
                        weak |= flag
            except (ValueError, TypeError):
                pass
        empty.update(message_key=_digest(message_id), thread_key=_thread_key(c, row, message_id),
                     recipient=recipient, role=profile['role_key'] if profile else '', scene=scene,
                     features=features, edits=edits, weak=weak)
    return observations


def _candidate_groups(samples):
    groups = defaultdict(list)
    for sample in samples:
        for scope, target in [('account', ''), ('role', sample['role']), ('contact', sample['recipient'])]:
            if target or scope == 'account':
                groups[scope, target, sample['scene']].append(sample)
    return groups


def _suggestions(samples, scope):
    # A conversation earns one vote. A repeated manual correction can be
    # stronger than older examples of how the same emails originally read.
    for field in style.FIELDS:
        if field == 'salutation' and scope != 'contact':
            continue
        weak_flag = _WEAK_SUBJECT if field == 'subject' else _WEAK_BODY
        observed, corrected = {}, {}
        for sample in samples:
            thread = sample['thread_key']
            if not sample['weak'] & weak_flag:
                observed.setdefault(thread, sample)
            if field in sample['edits']:
                corrected.setdefault(thread, sample)
        candidates = [(corrected, True), (observed, False)]
        for votes, edit in candidates:
            if len(votes) < 3:
                continue
            def value(sample):
                return sample['edits'][field]['value'] if edit else sample['features'].get(field, '')
            winner, count = Counter(value(sample) for sample in votes.values()).most_common(1)[0]
            if not winner or count < 3 or count * 3 < len(votes) * 2:
                continue
            evidence = [[sample['source'], sample['source_id']] for sample in votes.values() if value(sample) == winner]
            yield field, winner, evidence[:12], count
            break


def _recommendations(c, learned, since):
    for (scope, target, scene), new in _candidate_groups(learned).items():
        column = {'role': 'role', 'contact': 'recipient'}.get(scope)
        params = (scene, since, target) if column else (scene, since)
        query = (f'''SELECT s.*,
            ((s.source='local' AND EXISTS (SELECT 1 FROM sent_messages m WHERE m.id=s.source_id AND {_LOCAL_AVAILABLE}))
              OR (s.source='server' AND EXISTS (SELECT 1 FROM emails m WHERE m.id=s.source_id AND m.status='sent'
                    AND m.remote_missing=0 AND m.pending_action=''))) AS available
            FROM writing_memory_samples s WHERE s.message_key IS NOT NULL AND s.scene=? AND s.sent_at>=?''' +
                 (f' AND s.{column}=?' if column else '') + ' ORDER BY s.sent_at DESC LIMIT 80')
        prior = [dict(row, features=json.loads(row['features']), edits=json.loads(row['edits']))
                 for row in c.execute(query, params) if row['available']]
        rows = sorted([*new, *prior], key=lambda row: row['sent_at'], reverse=True)[:80]
        for field, value, evidence, count in _suggestions(rows, scope):
            yield scope, target, scene, field, value, json.dumps(dict(refs=evidence, count=count))


@contextmanager
def _connection(path=None, *, read_only=True):
    location = Path(path or config.DB_PATH).resolve().as_uri()
    mode, timeout = ('ro', .025) if read_only else ('rw', 0)
    with closing(sqlite3.connect(f'{location}?mode={mode}', uri=True, timeout=timeout)) as c, c:
        c.row_factory = sqlite3.Row
        yield c


def process_batch(commit_lease=None, *, budget=BATCH):
    path = Path(config.DB_PATH)
    identity = path.stat()
    with _connection(path) as c:
        state = dict(_state(c))
        if not state['collect'] or not state['enabled']:
            return 0
        since = max(state['since'], (datetime.now() - timedelta(days=max(HISTORY_DAYS))).date().isoformat())
        batches = {source: _batch_ids(c, source, since, budget) for source in _FIELDS}
        if not any(queued or checkpoint for _, queued, checkpoint in batches.values()):
            return 0
        observations = []
        learned, seen_keys = [], set()
        for source, (ids, _, _) in batches.items():
            for sample in _observations(c, _source_rows(c, source, state, since, ids), state, source):
                source_id, sent_at = sample['source_id'], sample['sent_at']
                message_key = sample.get('message_key')
                if message_key and (message_key in seen_keys or c.execute(
                    'SELECT 1 FROM writing_memory_samples WHERE message_key=?', (message_key,)).fetchone()):
                    sample = dict(source=source, source_id=source_id, sent_at=sent_at)
                if sample.get('message_key'):
                    learned.append(sample)
                    seen_keys.add(message_key)
                observations.append(sample)
        recommendations = list(_recommendations(c, learned, since))
        encoded = [dict({'message_key':None, 'thread_key':None, 'recipient':'', 'role':'', 'scene':'', 'weak':0},
                        **sample, features_json=json.dumps(sample.get('features',{}),ensure_ascii=False),
                        edits_json=json.dumps(sample.get('edits',{}),ensure_ascii=False)) for sample in observations]

    with (commit_lease() if commit_lease else nullcontext(True)) as ready:
        if not ready:
            return 0
        current_file = path.stat()
        if (identity.st_dev, identity.st_ino) != (current_file.st_dev, current_file.st_ino):
            return 0
        return _commit_batch(state, batches, encoded, recommendations, len(learned))


def _commit_batch(state, batches, samples, recommendations, learned):
    with _connection(read_only=False) as c:
        # Give foreground writers priority. The same checkpoint is retried later.
        c.execute('BEGIN IMMEDIATE')
        if dict(_state(c)) != state:
            return 0
        for sample in samples:
            source = sample['source']
            table = _FIELDS[source]
            status = _ELIGIBLE[source] + (f' AND {_SERVER_FILTER}' if source == 'server' else '')
            if not c.execute(f'SELECT 1 FROM {table} WHERE id=? AND {_DATES[source]}=? AND {status}',
                             (sample['source_id'],sample['sent_at'])).fetchone():
                return 0
        c.executemany('''INSERT INTO writing_memory_samples
            (source,source_id,message_key,thread_key,recipient,role,scene,sent_at,features,edits,weak)
            VALUES(:source,:source_id,:message_key,:thread_key,:recipient,:role,:scene,:sent_at,:features_json,:edits_json,:weak)''', samples)
        c.executemany("UPDATE sent_messages SET writing_sample='' WHERE id=? AND writing_sample<>''",
                      ((sample['source_id'],) for sample in samples if sample['source'] == 'local'))
        c.executemany('''INSERT INTO writing_memory_rules(scope,target,scene,field,value,evidence,status)
            VALUES(?,?,?,?,?,?,'adopted') ON CONFLICT(scope,target,scene,field) DO UPDATE SET
            value=excluded.value,evidence=excluded.evidence,revision=writing_memory_rules.revision+1
            WHERE writing_memory_rules.status='adopted' AND writing_memory_rules.edited=0 AND
            (writing_memory_rules.value<>excluded.value OR writing_memory_rules.evidence<>excluded.evidence)''', recommendations)
        for source, (_, queued, checkpoint) in batches.items():
            c.executemany('DELETE FROM writing_memory_queue WHERE source=? AND source_id=?', ((source, source_id) for source_id in queued))
            if checkpoint:
                c.execute('''INSERT INTO writing_memory_cursor(source,before_date,before_id,done) VALUES(?,?,?,?)
                    ON CONFLICT(source) DO UPDATE SET before_date=excluded.before_date,before_id=excluded.before_id,done=excluded.done''',
                          (source, *checkpoint))
        c.execute('UPDATE writing_memory_state SET observed=observed+?,batch_version=batch_version+1 WHERE id=1', (learned,))
    return len(samples)


@contextmanager
def _commit_lease(key, path):
    from . import system_settings
    from .account_guard import guard

    if not guard.acquire():
        yield False
        return
    try:
        account = system_settings._load_registry().get('accounts', {}).get(key, {})
        yield account.get('visible', True) and account.get('db_path') == path
    finally:
        guard.release()


def _tune_batch(key, elapsed, *, contended=False):
    budget, streak = _batch_limits.get(key, (BATCH, 0))
    if contended or elapsed >= SLOW_BATCH_SECONDS:
        _batch_limits[key] = (max(MIN_BATCH, budget // 2), 0)
    elif budget < BATCH:
        streak = streak + 1 if elapsed <= FAST_BATCH_SECONDS else 0
        if streak < RECOVERY_BATCHES:
            _batch_limits[key] = (budget, streak)
        elif budget * 2 < BATCH:
            _batch_limits[key] = (budget * 2, 0)
        else:
            _batch_limits.pop(key, None)


def run_due():
    """Rotate accounts while limiting each scheduler tick to one useful batch."""
    from . import system_settings
    from .account_context import use
    from .energy_scheduler import background_priority

    global _account_cursor
    background_priority()
    accounts = [(key, value) for key, value in system_settings._load_registry().get('accounts', {}).items()
                if value.get('visible', True) and value.get('db_path')]
    for key in _batch_limits.keys() - {key for key, _ in accounts}:
        del _batch_limits[key]
    for _ in range(min(4, len(accounts))):
        key, account = accounts[_account_cursor % len(accounts)]
        _account_cursor = (_account_cursor + 1) % len(accounts)
        path = account['db_path']
        budget, _ = _batch_limits.get(key, (BATCH, 0))
        started = monotonic()
        try:
            with use(dict(ACCOUNT_ID=key, DB_PATH=path, IMAP_USER=account.get('user', ''))):
                processed = process_batch(lambda: _commit_lease(key, path), budget=budget)
        except FileNotFoundError:
            continue  # A removed account must never recreate its database.
        except sqlite3.OperationalError as exc:
            code = getattr(exc, 'sqlite_errorcode', 0) & 0xFF
            if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or 'locked' in str(exc):
                _tune_batch(key, monotonic() - started, contended=True)
            elif not any(text in str(exc) for text in ('no such table', 'no such column')):
                log.warning('Writing memory batch postponed (%s)', type(exc).__name__)
        except Exception as exc:
            log.warning('Writing memory batch postponed (%s)', type(exc).__name__)
        else:
            if processed:
                _tune_batch(key, monotonic() - started)
                break


def listing(offset, limit):
    with db.conn() as c:
        state = _state(c)
        total = c.execute("SELECT COUNT(*) FROM writing_memory_rules WHERE status<>'deleted'").fetchone()[0]
        items = [dict(row) for row in c.execute('''SELECT * FROM writing_memory_rules WHERE status<>'deleted'
            ORDER BY id DESC LIMIT ? OFFSET ?''', (limit, offset))]
        for item in items:
            evidence = json.loads(item['evidence'])
            item['count'] = evidence.get('count', 0)
            item['evidence'] = []
            for source, source_id in evidence.get('refs', [])[:5]:
                row = c.execute('SELECT sent_at,edits FROM writing_memory_samples WHERE source=? AND source_id=?', (source, source_id)).fetchone()
                table = _FIELDS[source]
                available = _LOCAL_AVAILABLE if source == 'local' else "m.status='sent' AND m.remote_missing=0 AND m.pending_action=''"
                mail = c.execute(f'SELECT m.subject FROM {table} m WHERE m.id=? AND {available}', (source_id,)).fetchone()
                if row and mail:
                    edit = json.loads(row['edits']).get(item['field'], {})
                    item['evidence'].append(dict(source=source, id=source_id, date=row['sent_at'], subject=mail['subject'] or '',
                                                 before=edit.get('before', ''), after=edit.get('after', '')))
        return dict(settings=_public_settings(state), items=items, total=total, observed=state['observed'])


def update(rule_id, revision, action, value=None, scope=None):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute("SELECT * FROM writing_memory_rules WHERE id=? AND status<>'deleted'", (rule_id,)).fetchone()
        if not row or row['revision'] != revision:
            return False
        if action == 'save':
            value = value.strip() if isinstance(value, str) else value
            if not style.valid_value(row['field'], value):
                return False
            scope, target = scope or row['scope'], row['target']
            if scope != row['scope']:
                if scope != 'account' or row['field'] == 'salutation':
                    return False
                target = ''
                if c.execute('SELECT 1 FROM writing_memory_rules WHERE scope=? AND target=? AND scene=? AND field=?',
                             (scope, target, row['scene'], row['field'])).fetchone():
                    return False
            c.execute('''UPDATE writing_memory_rules SET value=?,scope=?,target=?,edited=1,
                revision=revision+1 WHERE id=?''', (value, scope, target, rule_id))
        elif action == 'delete':
            c.execute("UPDATE writing_memory_rules SET value='',evidence='{}',status='deleted',revision=revision+1 WHERE id=?", (rule_id,))
        elif action in ('approve', 'resume', 'pause'):
            c.execute('UPDATE writing_memory_rules SET status=?,revision=revision+1 WHERE id=?',
                      ('paused' if action == 'pause' else 'adopted', rule_id))
        else:
            return False
    return True


def recall(to, cc, bcc, scene, persona):
    """Resolve active rules by account, current audience and compose scene."""
    to, cc, bcc = style.audience(dict(to_addr=to, cc_addr=cc, bcc_addr=bcc))
    if not to or scene not in ('compose', 'reply'):
        return {}
    effective = persona.get('effective') or {}
    single = len(to) == 1 and not (cc or bcc)
    recipient = to[0] if single else ''
    role = (effective.get('role_key') or '') if single else ''
    try:
        with _connection() as c:
            if not _state(c)['enabled']:
                return {}
            rows = [row for scope, target in (('contact',recipient), ('role',role), ('account','')) if target or scope == 'account'
                    for row in c.execute('''SELECT scope,field,value FROM writing_memory_rules
                        WHERE scope=? AND target=? AND scene=? AND status='adopted' ''', (scope,target,scene))]
    except sqlite3.Error:
        return {}
    chosen = {}
    for row in rows:
        field, value = row['field'], row['value']
        if not style.valid_value(field, value) or field == 'salutation' and not single:
            continue
        if field == 'salutation' and effective.get('salutation'):
            continue
        contact = next(iter(persona.get('recipients') or []), {}) if single else {}
        if field == 'tone' and contact.get('comm_profile', {}).get('tone'):
            continue
        chosen.setdefault(field, dict(value=value, scope=row['scope']))
    return chosen


def reply_language(source_id, original_text):
    if original_text.strip():
        guess = style.language(style.clean_text(original_text[:5000]))
        if guess:
            return guess
    if not source_id:
        return ''
    try:
        with _connection() as c:
            row = c.execute('''SELECT substr(body_text,1,5000) AS body_text,substr(body_html,1,8000) AS body_html
                FROM emails WHERE id=?''', (source_id,)).fetchone()
        return style.language(style.authored_text(dict(row))) if row else ''
    except sqlite3.Error:
        return ''


def prompt(rules):
    lines = []
    for field, item in rules.items():
        value = item['value']
        if field == 'language':
            continue
        lines.append(f'常用称呼：{value}' if field == 'salutation' else _PROMPT[field][value])
    return '\n'.join(lines)
