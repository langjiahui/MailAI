"""Account-local XiaoYou growth. Only counters and deduplication keys, never mail text.

All awards and purchases use the same SQLite write transaction as their source
operation where possible. Spending stamps never subtracts lifetime experience.
"""
import hashlib
import json
import logging
import time
from datetime import datetime, timedelta
from uuid import uuid4

from . import db

log = logging.getLogger(__name__)
STAGES = (0, 240, 1200, 3600, 9000, 20000, 50000)
# count limit, units per award, XP, stamps. Seconds stay in seconds in storage.
RULES = {
    'active': (1800, 60, 2, 1), 'reading': (1200, 30, 2, 1),
    'click': (40, 5, 1, 1), 'read': (20, 1, 5, 3),
    'received': (20, 1, 2, 1), 'sent': (10, 1, 10, 5),
    'tool': (10, 1, 6, 3), 'learn': (5, 1, 5, 3),
}
QUESTS = {
    'reader': ('read', 3, 15, 8),
    'focus': ('active', 600, 15, 8),
    'helper': ('tool', 2, 15, 8),
    'student': ('learn', 1, 10, 5),
}
ITEMS = {
    'scarf': {'slot': 'accessory', 'cost': 80, 'stage': 1},
    'sky': {'slot': 'palette', 'cost': 120, 'stage': 1},
    'peach': {'slot': 'palette', 'cost': 120, 'stage': 1},
    'cap': {'slot': 'accessory', 'cost': 180, 'stage': 2},
    'satchel': {'slot': 'accessory', 'cost': 220, 'stage': 3},
    'sparkles': {'slot': 'effect', 'cost': 240, 'stage': 3},
    'orbit': {'slot': 'effect', 'cost': 380, 'stage': 4},
    'wings': {'slot': 'accessory', 'cost': 600, 'stage': 5},
    'aurora': {'slot': 'effect', 'cost': 800, 'stage': 6},
    'midnight': {'slot': 'palette', 'cost': 120, 'stage': 1},
    'jacket': {'slot': 'accessory', 'cost': 180, 'stage': 2},
    'visor': {'slot': 'accessory', 'cost': 240, 'stage': 3},
    'armor': {'slot': 'accessory', 'cost': 380, 'stage': 4},
    'lightning': {'slot': 'effect', 'cost': 480, 'stage': 4},
    'mech_wings': {'slot': 'accessory', 'cost': 700, 'stage': 5},
    'theme_monochrome': {'slot': 'theme', 'cost': 300, 'stage': 1},
    'theme_baowu': {'slot': 'theme', 'cost': 480, 'stage': 1},
    'berry': {'slot': 'consumable', 'cost': 120, 'stage': 1, 'xp': 80},
}


def initialize(c):
    c.executescript('''
        CREATE TABLE IF NOT EXISTS companion_profile (
            id INTEGER PRIMARY KEY CHECK(id=1), xp INTEGER NOT NULL DEFAULT 0,
            stamps INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0, last_day TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1, last_tick REAL NOT NULL DEFAULT 0,
            equipped TEXT NOT NULL DEFAULT '{}', style TEXT NOT NULL DEFAULT 'nature',
            cleanup_day TEXT NOT NULL DEFAULT ''
        );
        INSERT OR IGNORE INTO companion_profile(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS companion_days (
            day TEXT PRIMARY KEY, counts TEXT NOT NULL DEFAULT '{}',
            quests TEXT NOT NULL DEFAULT '[]', xp INTEGER NOT NULL DEFAULT 0,
            stamps INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS companion_events (
            key TEXT PRIMARY KEY, day TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_companion_events_day ON companion_events(day);
        CREATE TABLE IF NOT EXISTS companion_reading (
            day TEXT NOT NULL, email_id INTEGER NOT NULL, seconds INTEGER NOT NULL,
            PRIMARY KEY(day,email_id)
        );
        CREATE TABLE IF NOT EXISTS companion_purchases (
            token TEXT PRIMARY KEY, item TEXT NOT NULL, cost INTEGER NOT NULL,
            xp INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS companion_inventory (
            item TEXT PRIMARY KEY, acquired_at TEXT NOT NULL
        );
    ''')
    columns = {r['name'] for r in c.execute('PRAGMA table_info(companion_profile)')}
    for name, default in (('style', 'nature'), ('cleanup_day', '')):
        if name not in columns:
            c.execute(f"ALTER TABLE companion_profile ADD COLUMN {name} TEXT NOT NULL DEFAULT '{default}'")


def _now():
    return datetime.now().astimezone()


def _profile(c):
    return dict(c.execute('SELECT * FROM companion_profile WHERE id=1').fetchone())


def _day(c, day):
    c.execute('INSERT OR IGNORE INTO companion_days(day) VALUES(?)', (day,))
    row = dict(c.execute('SELECT * FROM companion_days WHERE day=?', (day,)).fetchone())
    row['counts'], row['quests'] = json.loads(row['counts']), json.loads(row['quests'])
    return row


def _credit(c, row, xp, stamps):
    c.execute('UPDATE companion_profile SET xp=xp+?,stamps=stamps+?,earned=earned+? WHERE id=1',
              (xp, stamps, stamps))
    row['xp'] += xp
    row['stamps'] += stamps


def _save_day(c, row):
    c.execute('UPDATE companion_days SET counts=?,quests=?,xp=?,stamps=? WHERE day=?',
              (json.dumps(row['counts']), json.dumps(row['quests']), row['xp'], row['stamps'], row['day']))


def _award(c, kind, amount=1, *, key='', now=None):
    """Caller owns write transaction. Dedup keys are hashed and never contain content."""
    if kind not in RULES:
        raise ValueError('未知成长行为')
    profile = _profile(c)
    if not profile['enabled']:
        return False
    now = now or _now()
    day = now.date().isoformat()
    if key:
        digest = kind + ':' + hashlib.sha256(f'{kind}:{key}'.encode()).hexdigest()
        if not c.execute('INSERT OR IGNORE INTO companion_events VALUES(?,?)', (digest, day)).rowcount:
            return False
    row = _day(c, day)
    counts = row['counts']
    cap, unit, xp, stamps = RULES[kind]
    before = counts.get(kind, 0)
    after = before + max(0, int(amount))
    if after == before:
        return False
    # Incoming mail grows the pet, but does not claim an active-day streak.
    if kind != 'received' and profile['last_day'] != day:
        yesterday = (now.date() - timedelta(days=1)).isoformat()
        streak = profile['streak'] + 1 if profile['last_day'] == yesterday else 1
        c.execute('UPDATE companion_profile SET streak=?,last_day=? WHERE id=1', (streak, day))
        _credit(c, row, 10, 5)
        if streak % 7 == 0:
            _credit(c, row, 30, 20)
    counts[kind] = after
    earned_units = min(cap, after) // unit - min(cap, before) // unit
    _credit(c, row, earned_units * xp, earned_units * stamps)
    for quest, (metric, target, bonus_xp, bonus_stamps) in QUESTS.items():
        if quest not in row['quests'] and counts.get(metric, 0) >= target:
            row['quests'].append(quest)
            _credit(c, row, bonus_xp, bonus_stamps)
    _save_day(c, row)
    return True


def record(kind, *, key='', now=None):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        return _award(c, kind, key=key, now=now)


def safe_record(kind, *, key='', connection=None):
    """Optional growth must never prevent receiving, sending or assistant work."""
    try:
        if connection is not None:
            # Roll back partial optional awards without touching the mail transaction.
            connection.execute('SAVEPOINT companion_award')
            try:
                _award(connection, kind, key=key)
            except Exception:
                connection.execute('ROLLBACK TO companion_award')
                raise
            finally:
                connection.execute('RELEASE companion_award')
        else:
            record(kind, key=key)
    except Exception:
        log.exception('小邮成长记录暂时不可用')


def _snapshot(c, now=None):
    now = now or _now()
    profile = _profile(c)
    stage = sum(profile['xp'] >= value for value in STAGES)
    today = c.execute('SELECT * FROM companion_days WHERE day=?', (now.date().isoformat(),)).fetchone()
    counts = json.loads(today['counts']) if today else {}
    completed = json.loads(today['quests']) if today else []
    inventory = {r['item'] for r in c.execute('SELECT item FROM companion_inventory')}
    last = profile['last_day']
    streak = profile['streak'] if last in (now.date().isoformat(), (now.date()-timedelta(days=1)).isoformat()) else 0
    return {
        'xp': profile['xp'], 'stamps': profile['stamps'], 'earned': profile['earned'],
        'enabled': bool(profile['enabled']), 'stage': stage, 'stage_floor': STAGES[stage-1],
        'next_stage_xp': STAGES[stage] if stage < len(STAGES) else None,
        'streak': streak, 'day': now.date().isoformat(), 'style': profile['style'], 'equipped': json.loads(profile['equipped']),
        'today': {'counts': counts, 'xp': today['xp'] if today else 0, 'stamps': today['stamps'] if today else 0},
        'rules': {kind: {'cap': cap, 'unit': unit, 'xp': xp, 'stamps': stamps} for kind, (cap, unit, xp, stamps) in RULES.items()},
        'quests': [{'id': quest, 'metric': metric, 'target': target, 'xp': xp, 'stamps': stamps,
                    'progress': min(target, counts.get(metric, 0)), 'complete': quest in completed}
                   for quest, (metric, target, xp, stamps) in QUESTS.items()],
        'items': [{'id': name, **item, 'owned': name in inventory} for name, item in ITEMS.items()],
        'stages': list(STAGES),
        'history': [{'day': r['day'], 'xp': r['xp'], 'stamps': r['stamps']} for r in
                    c.execute('SELECT day,xp,stamps FROM companion_days ORDER BY day DESC LIMIT 14')],
        'berry_today': counts.get('berry', 0),
        'purchases': [dict(r) for r in c.execute(
            'SELECT item,cost,xp,created_at FROM companion_purchases WHERE cost>0 ORDER BY rowid DESC LIMIT 20')],
    }


def snapshot():
    with db.conn() as c:
        c.execute('BEGIN')  # Keep profile, balance and inventory in one consistent read view.
        return _snapshot(c)


def heartbeat(token, active=0, reading=0, clicks=0, email_id=None, learn=''):
    """One client batch, safe to retry. Wall time bounds concurrent-tab timers."""
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        profile = _profile(c)
        if not profile['enabled']:
            return _snapshot(c)
        day = _now().date().isoformat()
        if not c.execute('INSERT OR IGNORE INTO companion_events VALUES(?,?)', ('tick:' + token, day)).rowcount:
            return _snapshot(c)
        if profile['cleanup_day'] != day:
            c.execute("DELETE FROM companion_events WHERE day<? AND key LIKE 'tick:%'",
                      ((_now().date()-timedelta(days=2)).isoformat(),))
            cutoff = (_now().date()-timedelta(days=30)).isoformat()
            c.execute('DELETE FROM companion_reading WHERE day<?', (cutoff,))
            c.execute("DELETE FROM companion_events WHERE day<? AND (key LIKE 'read:%' OR key LIKE 'learn:%')", (cutoff,))
            c.execute('UPDATE companion_profile SET cleanup_day=? WHERE id=1', (day,))
        tick = time.time()
        # First report is delayed by the frontend's 10s timer; subsequent reports
        # share a server clock across tabs. Never backfill idle or offline time.
        elapsed = max(0, min(30, int(tick - profile['last_tick']))) if profile['last_tick'] else 10
        active = min(active, elapsed)
        c.execute('UPDATE companion_profile SET last_tick=? WHERE id=1', (tick,))
        if active:
            _award(c, 'active', active)
        if clicks:
            _award(c, 'click', min(clicks, 10))
        if reading and active and email_id and c.execute('SELECT 1 FROM emails WHERE id=?', (email_id,)).fetchone():
            reading = min(reading, active)
            _award(c, 'reading', reading)
            observed = c.execute('SELECT seconds FROM companion_reading WHERE day=? AND email_id=?',
                                 (day, email_id)).fetchone()
            seconds = min(8, (observed['seconds'] if observed else 0) + reading)
            if not observed or observed['seconds'] < 8:
                c.execute('INSERT INTO companion_reading VALUES(?,?,?) ON CONFLICT(day,email_id) DO UPDATE SET seconds=excluded.seconds',
                          (day, email_id, seconds))
            if seconds >= 8:
                _award(c, 'read', key=f'{day}:{email_id}')
        if learn:
            _award(c, 'learn', key=f'{day}:{learn}')
        return _snapshot(c)


def purchase(item_id, token=''):
    item = ITEMS.get(item_id)
    if not item:
        raise ValueError('道具不存在')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        token = token or uuid4().hex
        receipt = c.execute('SELECT item FROM companion_purchases WHERE token=?', (token,)).fetchone()
        if receipt:
            if receipt['item'] != item_id:
                raise ValueError('兑换请求与道具不一致')
            return _snapshot(c)
        profile = _profile(c)
        stage = sum(profile['xp'] >= value for value in STAGES)
        if stage < item['stage']:
            raise ValueError('达到对应成长阶段后即可兑换')
        if item['slot'] != 'consumable' and c.execute('SELECT 1 FROM companion_inventory WHERE item=?', (item_id,)).fetchone():
            c.execute('INSERT INTO companion_purchases VALUES(?,?,0,0,?)', (token, item_id, _now().isoformat()))
            return _snapshot(c)
        row = _day(c, _now().date().isoformat())
        if item['slot'] == 'consumable' and row['counts'].get('berry', 0) >= 3:
            raise ValueError('成长莓每天最多使用 3 次')
        if profile['stamps'] < item['cost']:
            raise ValueError('邮票积分不足，完成日常活动即可积累')
        c.execute('UPDATE companion_profile SET stamps=stamps-? WHERE id=1', (item['cost'],))
        if item['slot'] == 'consumable':
            row['counts']['berry'] = row['counts'].get('berry', 0) + 1
            _credit(c, row, item['xp'], 0)
            _save_day(c, row)
        else:
            c.execute('INSERT INTO companion_inventory VALUES(?,?)', (item_id, _now().isoformat()))
            equipped = json.loads(profile['equipped'])
            equipped[item['slot']] = item_id
            c.execute('UPDATE companion_profile SET equipped=? WHERE id=1', (json.dumps(equipped),))
        c.execute('INSERT INTO companion_purchases VALUES(?,?,?,?,?)',
                  (token, item_id, item['cost'], item.get('xp', 0), _now().isoformat()))
        return _snapshot(c)


def equip(slot, item_id):
    if slot not in ('palette', 'accessory', 'effect', 'theme'):
        raise ValueError('装扮位置无效')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if item_id and (item_id not in ITEMS or ITEMS[item_id]['slot'] != slot or not c.execute(
                'SELECT 1 FROM companion_inventory WHERE item=?', (item_id,)).fetchone()):
            raise ValueError('请先兑换此装扮')
        equipped = json.loads(_profile(c)['equipped'])
        if item_id:
            equipped[slot] = item_id
        else:
            equipped.pop(slot, None)
        c.execute('UPDATE companion_profile SET equipped=? WHERE id=1', (json.dumps(equipped),))
        return _snapshot(c)


def set_enabled(enabled):
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute('UPDATE companion_profile SET enabled=?,last_tick=? WHERE id=1', (int(enabled), time.time()))
        return _snapshot(c)


def set_style(style):
    if style not in ('nature', 'ranger'):
        raise ValueError('形象路线无效')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        c.execute('UPDATE companion_profile SET style=? WHERE id=1', (style,))
        return _snapshot(c)
