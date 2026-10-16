"""Account-local mail labels and deterministic, additive arrival rules."""
import json
import re
import logging

from .core import conn

log = logging.getLogger(__name__)


def initialize(c):
    c.executescript('''
        CREATE TABLE IF NOT EXISTS mail_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            color TEXT NOT NULL DEFAULT '#548879'
        );
        CREATE TABLE IF NOT EXISTS email_tags (
            email_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
            PRIMARY KEY(email_id,tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_email_tags_tag ON email_tags(tag_id,email_id);
        CREATE TABLE IF NOT EXISTS mail_tag_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, match_mode TEXT NOT NULL,
            conditions TEXT NOT NULL, tag_ids TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS mail_tags_email_cleanup AFTER DELETE ON emails
        BEGIN DELETE FROM email_tags WHERE email_id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS mail_tags_delete_cleanup AFTER DELETE ON mail_tags
        BEGIN DELETE FROM email_tags WHERE tag_id=OLD.id; END;
    ''')
    for table in ('mail_tags', 'email_tags'):
        for action in ('INSERT', 'UPDATE', 'DELETE'):
            c.execute(f'''CREATE TRIGGER IF NOT EXISTS {table}_revision_{action.lower()}
                AFTER {action} ON {table} BEGIN
                UPDATE mailbox_sequence SET value=value+1 WHERE id=1; END''')


def annotate(c, items):
    indexed = {item['id']: item for item in items if 'id' in item}
    for item in indexed.values():
        item['tags'] = []
    if not indexed or not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_tags'").fetchone():
        return items
    ids = list(indexed)
    for start in range(0, len(ids), 500):
        batch = ids[start:start + 500]
        placeholders = ','.join('?' for _ in batch)
        for row in c.execute(f'''SELECT et.email_id,t.id,t.name,t.color FROM email_tags et
                JOIN mail_tags t ON t.id=et.tag_id WHERE et.email_id IN ({placeholders})
                ORDER BY t.name,t.id''', batch):
            indexed[row['email_id']]['tags'].append({key: row[key] for key in ('id', 'name', 'color')})
    return items


def catalog():
    with conn() as c:
        return [dict(row) for row in c.execute('''SELECT t.*,COUNT(e.id) AS count FROM mail_tags t
            LEFT JOIN email_tags et ON et.tag_id=t.id
            LEFT JOIN emails e ON e.id=et.email_id AND e.remote_missing=0
            GROUP BY t.id ORDER BY t.name,t.id''')]


def valid_name(value):
    value = str(value or '').strip()
    if not value or len(value) > 80 or re.search(r'[\x00-\x1f]', value):
        raise ValueError('名称不能为空，不能包含控制字符，且不能超过 80 字')
    return value


def save_tag(name, color='#548879', tag_id=None):
    import sqlite3
    name = valid_name(name)
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('请选择有效的标签颜色')
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        try:
            if tag_id is None:
                tag_id = c.execute('INSERT INTO mail_tags(name,color) VALUES(?,?)', (name, color)).lastrowid
            elif not c.execute('UPDATE mail_tags SET name=?,color=? WHERE id=?', (name, color, tag_id)).rowcount:
                raise ValueError('标签已不存在，请刷新后重试')
        except sqlite3.IntegrityError as error:
            raise ValueError('标签名称已存在') from error
    return {'id': tag_id, 'name': name, 'color': color}


def delete_tag(tag_id):
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        # Remove deleted targets from rules; rules with no targets are removed.
        for row in c.execute('SELECT id,tag_ids FROM mail_tag_rules').fetchall():
            try:
                targets = json.loads(row['tag_ids'])
                ids = [i for i in targets if type(i) is int and i != tag_id] if isinstance(targets, list) else []
            except (TypeError, ValueError):
                ids = []
            if ids:
                c.execute('UPDATE mail_tag_rules SET tag_ids=? WHERE id=?', (json.dumps(ids), row['id']))
            else:
                c.execute('DELETE FROM mail_tag_rules WHERE id=?', (row['id'],))
        c.execute('DELETE FROM mail_tags WHERE id=?', (tag_id,))
    return {'ok': True}


def _validate_targets(c, tag_ids, limit=50):
    ids = list(dict.fromkeys(tag_ids))
    if len(ids) > limit or any(not isinstance(i, int) or isinstance(i, bool) or i < 1 for i in ids):
        raise ValueError('每次最多设置 50 个有效标签')
    existing = {row[0] for row in c.execute('SELECT id FROM mail_tags')}
    if not set(ids) <= existing:
        raise ValueError('标签已不存在，请刷新后重试')
    return ids


def update_members(email_ids, tag_ids, mode='add', original_tag_ids=None):
    ids = list(dict.fromkeys(email_ids))
    if not ids or len(ids) > 300 or mode not in ('add', 'remove', 'replace'):
        raise ValueError('每次请选择 1 至 300 封邮件和有效的设置方式')
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        tags = _validate_targets(c, tag_ids, 1000 if original_tag_ids is not None else 50)
        placeholders = ','.join('?' for _ in ids)
        if c.execute(f'SELECT COUNT(*) FROM emails WHERE id IN ({placeholders}) AND remote_missing=0', ids).fetchone()[0] != len(ids):
            raise ValueError('所选邮件已不存在，请刷新后重新选择')
        original = set(original_tag_ids) if original_tag_ids is not None else None
        if original is not None and (mode != 'replace' or len(ids) != 1 or len(original) > 1000):
            raise ValueError('无效的标签编辑快照，请重新打开设置窗口')
        for email_id in ids:
            if mode == 'replace' and original is not None:
                # Apply only what the user changed since opening the picker.
                # Background rules and other windows may have changed the rest.
                for tag_id in original - set(tags):
                    c.execute('DELETE FROM email_tags WHERE email_id=? AND tag_id=?', (email_id, tag_id))
                for tag_id in set(tags) - original:
                    c.execute('INSERT OR IGNORE INTO email_tags VALUES(?,?)', (email_id, tag_id))
                continue
            if mode == 'replace':
                c.execute('DELETE FROM email_tags WHERE email_id=?', (email_id,))
            for tag_id in tags:
                if mode == 'remove':
                    c.execute('DELETE FROM email_tags WHERE email_id=? AND tag_id=?', (email_id, tag_id))
                else:
                    c.execute('INSERT OR IGNORE INTO email_tags VALUES(?,?)', (email_id, tag_id))
        updated = annotate(c, [{'id': email_id} for email_id in ids])
    return {'ok': True, 'count': len(ids), 'items': updated}


def rules(c=None, enabled_only=False):
    if c is None:
        with conn() as connection:
            return rules(connection, enabled_only)
    result = []
    for row in c.execute('SELECT * FROM mail_tag_rules' + (' WHERE enabled=1' if enabled_only else '') + ' ORDER BY id'):
        try:
            item = dict(row)
            item['enabled'] = bool(item['enabled'])
            for key in ('conditions', 'tag_ids'):
                item[key] = json.loads(item[key])
            item['conditions'] = valid_conditions(item['conditions'], item['match_mode'])
            if not isinstance(item['tag_ids'], list) or not item['tag_ids'] or any(type(i) is not int or i < 1 for i in item['tag_ids']):
                raise ValueError('Invalid stored targets')
        except (TypeError, ValueError, KeyError):
            # A malformed optional rule must never prevent mail from arriving.
            log.warning('Skipping invalid mail label rule id=%s', row['id'])
            continue
        result.append(item)
    return result


def valid_conditions(conditions, match_mode):
    if match_mode not in ('all', 'any') or not isinstance(conditions, list) or not 1 <= len(conditions) <= 20:
        raise ValueError('请选择匹配方式并设置 1 至 20 条条件')
    cleaned = []
    for condition in conditions:
        if not isinstance(condition, dict):
            raise ValueError('规则条件无效，请重新设置')
        field, operator = condition.get('field'), condition.get('operator', 'contains')
        value = str(condition.get('value', '')).strip()
        if field not in ('sender', 'subject', 'body') or operator not in ('contains', 'equals', 'not_contains') or not value or len(value) > 500:
            raise ValueError('规则条件必须选择发件人、主题或正文，并填写 1 至 500 字的匹配内容')
        cleaned.append({'field': field, 'operator': operator, 'value': value})
    return cleaned


def save_rule(name, conditions, tag_ids, match_mode='all', enabled=True, rule_id=None):
    name = valid_name(name)
    cleaned = valid_conditions(conditions, match_mode)
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        targets = _validate_targets(c, tag_ids)
        if not targets:
            raise ValueError('请至少选择一个标签')
        values = (name, int(enabled), match_mode, json.dumps(cleaned, ensure_ascii=False), json.dumps(targets))
        if rule_id is None:
            rule_id = c.execute('INSERT INTO mail_tag_rules(name,enabled,match_mode,conditions,tag_ids) VALUES(?,?,?,?,?)', values).lastrowid
        elif not c.execute('UPDATE mail_tag_rules SET name=?,enabled=?,match_mode=?,conditions=?,tag_ids=? WHERE id=?', (*values, rule_id)).rowcount:
            raise ValueError('规则已不存在，请刷新后重试')
    return {'ok': True, 'id': rule_id}


def delete_rule(rule_id):
    with conn() as c:
        c.execute('DELETE FROM mail_tag_rules WHERE id=?', (rule_id,))
    return {'ok': True}


def _match_values(email):
    from ..parser import strip_html
    address = str(email.get('from_addr') or '')
    name = str(email.get('from_name') or '')
    body = str(email.get('body_text') or '')
    if not body.strip():
        body = strip_html(str(email.get('body_html') or ''))
    normalize = lambda value: re.sub(r'\s+', ' ', str(value)).strip().casefold()
    return {key: normalize(value) for key, value in {
        'sender': ' '.join((name, address)), 'address': address, 'name': name,
        'subject': email.get('subject') or '', 'body': body,
    }.items()}


def matches(rule, email, values=None):
    values = _match_values(email) if values is None else values
    checks = []
    for condition in rule['conditions']:
        value = re.sub(r'\s+', ' ', condition['value']).strip().casefold()
        actual = values[condition['field']]
        # Unavailable body/header data cannot satisfy a negative condition.
        if not actual:
            check = False
        elif condition['operator'] == 'equals':
            check = value in (values['address'], values['name'], actual) if condition['field'] == 'sender' else actual == value
        else:
            check = value in actual
            if condition['operator'] == 'not_contains':
                check = not check
        checks.append(check)
    return bool(checks) and (all(checks) if rule['match_mode'] == 'all' else any(checks))


def apply_to_email(c, email_id, email, active_rules=None):
    targets = set()
    active = active_rules if active_rules is not None else rules(c, enabled_only=True)
    if not active:
        return 0
    values = _match_values(email)
    for rule in active:
        if matches(rule, email, values):
            targets.update(rule['tag_ids'])
    changed = 0
    for tag_id in targets:
        changed += c.execute('''INSERT OR IGNORE INTO email_tags(email_id,tag_id)
            SELECT ?,id FROM mail_tags WHERE id=?''', (email_id, tag_id)).rowcount
    return changed


def apply_existing():
    # Bound each write lease so a large history does not monopolize the mailbox.
    with conn() as c:
        active = rules(c, enabled_only=True)
        ceiling = c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
    cursor, count = 0, 0
    while active and cursor < ceiling:
        with conn() as c:
            c.execute('BEGIN IMMEDIATE')
            active = rules(c, enabled_only=True)
            if not active:
                break
            batch = c.execute('''SELECT id,from_addr,from_name,subject,body_text,body_html
                FROM emails WHERE remote_missing=0 AND id>? AND id<=? ORDER BY id LIMIT 100''',
                (cursor, ceiling)).fetchall()
            if not batch:
                break
            for row in batch:
                count += bool(apply_to_email(c, row['id'], dict(row), active))
            cursor = batch[-1]['id']
    return {'ok': True, 'count': count}


def filter_sql(names=(), mode='any'):
    """Apply tag filters before pagination; values always remain SQL parameters."""
    names = list(dict.fromkeys(names))
    if mode not in ('any', 'all') or len(names) > 50:
        raise ValueError('无效的标签筛选条件')
    if not names:
        return '', []
    placeholders = ','.join('?' for _ in names)
    query = f'''SELECT COUNT(DISTINCT mt.id) FROM email_tags et
        JOIN mail_tags mt ON mt.id=et.tag_id
        WHERE et.email_id=emails.id AND mt.name IN ({placeholders})'''
    return f' AND ({query})' + ('=?' if mode == 'all' else '>0'), [*names, len(names)] if mode == 'all' else names



def snapshot(email_ids):
    ids = list(dict.fromkeys(email_ids))
    if len(ids) > 1000:
        raise ValueError('每次最多读取 1000 封邮件的标签')
    with conn() as c:
        return annotate(c, [{'id': row[0]} for row in c.execute(
            f"SELECT id FROM emails WHERE id IN ({','.join('?' for _ in ids)}) AND remote_missing=0", ids)]) if ids else []



def preview(conditions, match_mode='all'):
    rule = {'conditions': valid_conditions(conditions, match_mode), 'match_mode': match_mode}
    with conn() as c:
        ceiling = c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
    cursor, count, examples = 0, 0, []
    while cursor < ceiling:
        with conn() as c:
            batch = c.execute("SELECT id,from_addr,from_name,subject,body_text,body_html FROM emails "
                              "WHERE remote_missing=0 AND id>? AND id<=? ORDER BY id LIMIT 50",
                              (cursor, ceiling)).fetchall()
        if not batch:
            break
        for row in batch:
            if matches(rule, dict(row)):
                count += 1
                if len(examples) < 3:
                    examples.append({key: row[key] for key in ('id', 'subject', 'from_addr')})
        cursor = batch[-1]['id']
    return {'count': count, 'examples': examples}
