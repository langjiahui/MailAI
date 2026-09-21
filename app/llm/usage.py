"""Device-local usage ledger. Never stores prompts, responses or credentials."""
import logging
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from .. import config

log = logging.getLogger(__name__)


@contextmanager
def connect():
    path = Path(config.USER_DATA_DIR) / 'model-usage.sqlite3'
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path, timeout=1)
    c.row_factory = sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, at REAL, account TEXT, provider TEXT, endpoint TEXT, model TEXT, input INTEGER, output INTEGER, total INTEGER)')
    c.execute('CREATE INDEX IF NOT EXISTS usage_time ON usage_events(at)')
    try:
        with c:
            yield c
    finally:
        c.close()


def context(provider, endpoint, model):
    # Keep identity stable through account/config switches during a request.
    parsed = urlsplit(endpoint)
    return dict(id=uuid.uuid4().hex, at=time.time(), account=config.IMAP_USER,
                provider=provider, endpoint=f'{parsed.scheme}://{parsed.netloc}{parsed.path}', model=model)


def record(ctx, response=None):
    try:
        usage = (response or {}).get('usage') or {}
        def count(*keys):
            for key in keys:
                value = usage.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    return value
            return None
        inp, out = count('prompt_tokens', 'input_tokens'), count('completion_tokens', 'output_tokens')
        total = count('total_tokens')
        if total is None and inp is not None and out is not None:
            total = inp + out
        with connect() as c:
            c.execute('INSERT OR IGNORE INTO usage_events VALUES(?,?,?,?,?,?,?,?,?)',
                      (*[ctx[k] for k in ('id','at','account','provider','endpoint','model')], inp,out,total))
    except Exception:
        log.warning('用量记录暂不可用，不影响模型调用')


def summary(period='all', account=''):
    from datetime import datetime
    now = datetime.now()
    start = now.replace(hour=0,minute=0,second=0,microsecond=0)
    if period == 'month':
        start = start.replace(day=1)
    since = 0 if period == 'all' else start.timestamp()
    with connect() as c:
        fields = ('COUNT(*) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, '
                  'COALESCE(SUM(total),0) total, SUM(CASE WHEN total IS NULL THEN 1 ELSE 0 END) unreported')
        where = 'WHERE at>=? AND (?=\'\' OR account=?)'
        args = (since, account, account)
        total = dict(c.execute(f'SELECT {fields} FROM usage_events {where}', args).fetchone())
        rows = [dict(r) for r in c.execute(f'SELECT provider,endpoint,model,{fields} FROM usage_events {where} GROUP BY provider,endpoint,model ORDER BY total DESC', args)]
        accounts = [r[0] for r in c.execute('SELECT DISTINCT account FROM usage_events ORDER BY account')]
        first = c.execute('SELECT MIN(at) FROM usage_events').fetchone()[0]
    return dict(**total, rows=rows, accounts=accounts, started_at=first)
