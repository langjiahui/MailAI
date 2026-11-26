"""Exercise bounded backfill and foreground mail work on a synthetic SQLite store."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
from statistics import median, quantiles
import sys
from tempfile import TemporaryDirectory
from threading import Event
from time import perf_counter
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, outbox, system_settings, writing_memory as memory
from app.account_context import use

OWNER = 'me@example.test'
TO = 'contact@example.test'
BODY = '<p>Hello team,<br>The design is confirmed and ready for review.</p>'
SERIES = 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)'


def seed(size, date):
    with db.conn(notify=False) as c:
        c.execute(SERIES + ''' INSERT INTO emails(uid,folder,status,from_addr,to_addr,subject,date,body_html)
            SELECT x,'INBOX','inbox',?,?,'Project status',strftime('%Y-%m-%dT%H:%M:%S',?,'-' || x || ' seconds'),? FROM n''',
                  (size//2,TO,OWNER,date,BODY))
        c.execute(SERIES + ''' INSERT INTO emails(uid,folder,status,from_addr,to_addr,subject,date,body_html,message_id)
            SELECT x,'Sent','sent',?,?,'Project status',?,?, '<remote-' || x || '@example.test>' FROM n''',
                  (size//3,OWNER,TO,date,BODY))
        c.execute(SERIES + ''' INSERT INTO sent_messages(status,from_addr,to_addr,subject,sent_at,body_html,message_id)
            SELECT 'sent',?,?,'Project status',?,?, '<local-' || x || '@example.test>' FROM n''',
                  (size-size//2-size//3,OWNER,TO,date,BODY))
        c.execute('''INSERT INTO writing_memory_samples(source,source_id,sent_at)
            SELECT 'server',id,date FROM emails WHERE status='sent' AND uid>16''')
        oldest = c.execute("SELECT id FROM emails WHERE folder='Sent' AND uid=17").fetchone()[0]
        c.execute("INSERT INTO writing_memory_cursor(source,before_date,before_id) VALUES('server',?,?)", (date,oldest))
        return oldest


def check_scan(date, oldest):
    cutoff = (datetime.now()-timedelta(days=90)).date().isoformat()
    with db.conn(notify=False) as c:
        counts = []
        results = []
        for execute in [lambda: c.execute('''SELECT m.id FROM emails m WHERE m.status='sent' AND m.remote_missing=0
            AND m.date>=? AND NOT EXISTS(SELECT 1 FROM writing_memory_samples s WHERE s.source='server' AND s.source_id=m.id)
            ORDER BY m.date DESC,m.id DESC LIMIT ?''', (cutoff,memory.BATCH)).fetchall(),
            lambda: memory._batch_ids(c,'server',cutoff)[0]]:
            ticks = []
            c.set_progress_handler(lambda: ticks.append(1) or 0, 100)
            results.append(execute())
            counts.append(len(ticks)*100)
        c.set_progress_handler(None,0)
        assert [row[0] for row in results[0]] == results[1] == list(range(oldest-1,oldest-17,-1))
        assert counts[1] < 3000, (date,counts)
        assert memory._batch_ids(c,'server',cutoff,budget=memory.MIN_BATCH)[0] == results[1][:memory.MIN_BATCH]
        return counts


def fake_delivery(payload):
    record = db.create_sent_message(dict(payload,from_addr=OWNER))
    db.finish_sent_message(record,ok=True,message_id=f'<outbox-{record}@example.test>')
    db.complete_sent_draft(payload['id'])
    return {'ok':True}


def foreground(prefix, rounds=60):
    read, receive, send = [], [], []
    draft = dict(to_addr=TO, subject='Project reply', body_html=BODY)
    date = datetime.now().isoformat(timespec='seconds')
    base_uid = {'warmup':1_000_000, 'baseline':2_000_000, 'concurrent':3_000_000}[prefix]
    for i in range(rounds):
        started = perf_counter()
        assert db.upsert_email(dict(uid=base_uid+i,folder='INBOX',status='inbox',date=date,
                                    from_addr=TO,to_addr=OWNER,subject='Incoming update',body_html=BODY))
        receive.append(perf_counter()-started)
        started = perf_counter()
        assert len(db.list_emails(status='inbox',days=9999,limit=50,list_view=True)) == 50
        read.append(perf_counter()-started)
        started = perf_counter()
        row = dict(draft, id=db.save_draft(draft))
        outbox.enqueue(f'{prefix}-{i}',row,delay=0)
        outbox.process(fake_delivery)
        send.append(perf_counter()-started)
    with db.conn(notify=False) as c:
        assert c.execute("SELECT COUNT(*) FROM outbox WHERE token LIKE ? AND status='sent'", (prefix+'-%',)).fetchone()[0] == rounds
    return dict(receive=receive, read=read, draft_and_send=send)


def verify_adaptive_batches():
    now, budgets = [0.0], []
    costs = iter([None, .2, .02, .02, .02, .02, .08, .02, .02, .02, .02])
    registry = {'accounts': {'adaptive': {'db_path': 'fixture.db'}}}

    def work(_lease, *, budget):
        budgets.append(budget)
        cost = next(costs)
        if cost is None:
            raise sqlite3.OperationalError('database is locked')
        now[0] += cost
        return 1

    with patch('app.energy_scheduler.background_priority'), \
         patch.object(system_settings, '_load_registry', return_value=registry), \
         patch.object(memory, '_account_cursor', 0), patch.object(memory, '_batch_limits', {}), \
         patch.object(memory, 'monotonic', side_effect=lambda: now[0]), \
         patch.object(memory, 'process_batch', side_effect=work):
        for _ in range(11):
            memory.run_due()
    assert budgets == [16, 8, 4, 4, 4, 8, 8, 8, 8, 8, 16], budgets


def main(size):
    verify_adaptive_batches()
    with TemporaryDirectory(prefix='mailai-writing-load-') as root:
        account = dict(ACCOUNT_ID='large',DB_PATH=str(Path(root)/'mail.db'),DATA_DIR=root,IMAP_USER=OWNER)
        with use(account):
            db.init_db()
            date = (datetime.now()-timedelta(days=3)).isoformat(timespec='seconds')
            local = db.create_sent_message(dict(from_addr=OWNER,to_addr=TO,subject='Late confirmation',body_html=BODY))
            oldest = seed(size, date)
            assert memory.configure(True,90,0)['collect']
            steps = check_scan(date, oldest)
            with db.conn(notify=False) as writer:
                writer.execute('BEGIN IMMEDIATE')
                started = perf_counter()
                try:
                    memory.process_batch()
                except sqlite3.OperationalError as exc:
                    assert 'locked' in str(exc)
                else:
                    raise AssertionError('Background write should have yielded to the foreground writer')
                busy_ms = round((perf_counter()-started)*1000,2)
            assert memory.listing(0,12)['observed'] == 0, 'Failed commits preserve the last completed checkpoint'

            original = memory._recommendations
            def verify_writer_is_free(*args):
                with db.conn(notify=False) as writer:
                    writer.execute('PRAGMA busy_timeout=0')
                    writer.execute('BEGIN IMMEDIATE')
                yield from original(*args)
            with patch.object(memory,'_recommendations',verify_writer_is_free):
                assert memory.process_batch() == 32

            running, stop = Event(), Event()
            def learn():
                timings, busy = [], 0
                with use(account):
                    running.set()
                    while not stop.is_set():
                        started = perf_counter()
                        try:
                            memory.process_batch()
                            timings.append(perf_counter()-started)
                        except sqlite3.OperationalError as exc:
                            assert 'locked' in str(exc)
                            busy += 1
                        stop.wait(.005)
                return timings, busy

            # Warm the same inbox page and SQLite write path before timing either run.
            foreground('warmup')
            baseline = foreground('baseline')
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(learn)
                try:
                    assert running.wait(5)
                    concurrent = foreground('concurrent')
                finally:
                    stop.set()
                timings, busy = pending.result(timeout=40)
            assert timings and memory.listing(0,12)['observed'] > 32
            # A confirmed send and a previously stored server row must both be
            # found by ID even after their historical ranges finish.
            with db.conn(notify=False) as c:
                c.execute('UPDATE writing_memory_cursor SET done=1')
                c.execute('DELETE FROM writing_memory_queue')
                late = c.execute("SELECT id FROM emails WHERE status='sent' AND uid=17").fetchone()[0]
                c.execute('DELETE FROM writing_memory_samples WHERE source=\'server\' AND source_id=?', (late,))
                c.execute("UPDATE emails SET remote_missing=1 WHERE id=?", (late,))
                c.execute("UPDATE emails SET remote_missing=0 WHERE id=?", (late,))
            db.finish_sent_message(local,ok=True,message_id='<late-confirmation@example.test>')
            db.init_db()
            assert memory.process_batch() == 2 and memory.process_batch() == 0
            with db.conn(notify=False) as c:
                assert c.execute('SELECT COUNT(*) FROM writing_memory_queue').fetchone()[0] == 0

            seen_accounts = []
            registry = {'accounts': {f'account{i}':{'db_path':f'fixture{i}.db'} for i in range(6)}}
            def useful_batch(_lease, *, budget):
                assert budget == memory.BATCH
                seen_accounts.append(config.DB_PATH)
                return 1
            with patch('app.energy_scheduler.background_priority'), \
                 patch.object(system_settings,'_load_registry',return_value=registry), \
                 patch.object(memory,'_account_cursor',0), patch.object(memory,'process_batch',side_effect=useful_batch):
                for _ in registry['accounts']:
                    memory.run_due()
            assert seen_accounts == [f'fixture{i}.db' for i in range(6)]

            def metrics(values):
                p95 = quantiles(values,n=20)[-1] if len(values)>1 else values[0]
                return {'p50_ms':round(median(values)*1000,2), 'p95_ms':round(p95*1000,2)}
            print(json.dumps({'fixture_messages':size,'historical_query_vm_steps':dict(previous=steps[0],current=steps[1]),
                'foreground_only':{key:metrics(rows) for key,rows in baseline.items()},
                'with_background':{key:metrics(rows) for key,rows in concurrent.items()},
                'background_batch':metrics(timings),'background_yields':busy,'busy_batch_ms':busy_ms},ensure_ascii=False))
    print('PASS large-mailbox writing memory: bounded historical scan, writer priority, queue restart and concurrent send/draft/read')


if __name__ == '__main__':
    main(200000 if '--large' in sys.argv else 12000)
