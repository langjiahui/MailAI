"""Legacy migration, shared caps, mailbox IDs, commit recovery and portable client state."""
import hashlib
import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, companion_growth as growth
from app.account_context import use


def test_first_store_initialization():
    with tempfile.TemporaryDirectory() as temp:
        account = dict(ACCOUNT_ID='first',DB_PATH=str(Path(temp)/'mailai.db'),IMAP_USER='first@example.test')
        with patch.object(config,'DATA_DIR',temp), use(account):
            db.init_db()
            growth.store_path().touch()  # Another request has opened the file, before creating its tables.
            with db.conn() as c:
                growth.safe_record('sent',key='first-committed-send',connection=c)
            result = growth.snapshot()
            assert result['xp'] == 20 and result['today']['counts']['sent'] == 1
            assert growth.snapshot() == result


def main():
    test_first_store_initialization()
    now = datetime(2026, 10, 10, 10, tzinfo=timezone(timedelta(hours=8)))
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        accounts = [dict(ACCOUNT_ID=name, DB_PATH=str(root / 'accounts' / name / 'mailai.db'),
                         IMAP_USER=name + '@example.test') for name in ('work', 'personal')]
        with patch.object(config, 'DATA_DIR', str(root)), patch.object(growth, '_now', return_value=now):
            for index, account in enumerate(accounts):
                Path(account['DB_PATH']).parent.mkdir(parents=True)
                with use(account):
                    db.init_db()
                    with db.conn() as c:
                        c.execute('INSERT INTO emails(id,uid) VALUES(1,1)')
                        c.execute('UPDATE companion_profile SET xp=?,stamps=?,earned=?,last_day=?,streak=1,last_tick=?,style=?,equipped=?',
                                  (103 if index == 0 else 16, 58 if index == 0 else 9, 58 if index == 0 else 9,
                                   now.date().isoformat(), 1000+index, 'ranger' if index == 1 else 'nature',
                                   json.dumps({'accessory':'scarf','theme':'theme_baowu'} if index == 1 else {'palette':'sky'})))
                        for item in ('scarf', 'theme_baowu') if index == 1 else ('scarf', 'sky'):
                            c.execute('INSERT INTO companion_inventory VALUES(?,?)', (item,now.isoformat()))
                        c.execute('INSERT INTO companion_days VALUES(?,?,?,?,?)',
                                  (now.date().isoformat(), json.dumps({'active':1700 if index == 0 else 100, 'read':1}), '[]', 103 if index == 0 else 16,58 if index == 0 else 9))
                        # Legacy hashed events must stay deduplicated after migration.
                        event = 'received:' + hashlib.sha256(b'received:legacy-message').hexdigest()
                        c.execute('INSERT INTO companion_events VALUES(?,?)', (event,now.date().isoformat()))
                        if index == 0:
                            c.execute('DROP TABLE companion_source')  # Unmodified v2.4 legacy schema.
            with use(accounts[0]):
                before = growth.snapshot()
                assert (before['xp'],before['stamps'],before['earned']) == (119,67,67)
                assert before['style'] == 'ranger' and before['equipped']['theme'] == 'theme_baowu'
                assert all(item['owned'] for item in before['items'] if item['id'] in ('scarf','sky','theme_baowu'))
                assert before['today']['counts']['active'] == 1800
                growth.record('received',key='legacy-message')
                assert growth.snapshot() == before
                with growth.connection() as c:
                    growth._award(c,'active',60)
                    assert growth._snapshot(c)['xp'] == before['xp'] + 15  # Focus goal once, timing cap exhausted.
                after = growth.snapshot()
                assert growth.snapshot() == after  # Migration is idempotent.
            with use(accounts[1]):
                assert growth.snapshot() == after
                growth.record('received',key='legacy-message')
                assert growth.snapshot() == after
                growth.set_enabled(False)
            with use(accounts[0]):
                assert not growth.snapshot()['enabled']
                growth.record('tool',key='paused-all-accounts')
                paused = growth.snapshot()
                with db.conn() as c:
                    growth.safe_record('sent',key='paused-mail',connection=c)
                assert growth.snapshot() == paused
                growth.set_enabled(True)
                # Same integer ID in two mailboxes denotes two different messages.
                with patch.object(growth.time,'time',return_value=2000):
                    a = growth.heartbeat('read-work-0001',active=10,reading=10,email_id=1)
                # Failed source mail transactions must never award.
                original = growth.snapshot()
                try:
                    with db.conn() as c:
                        growth.safe_record('sent',key='rolled-back-send',connection=c)
                        raise RuntimeError('source transaction rolled back')
                except RuntimeError: pass
                assert growth.snapshot() == original
                # A failed growth transaction retains its outbox and rolls back partial awards.
                def failed(c,*args,**kwargs):
                    c.execute('UPDATE companion_profile SET xp=xp+999 WHERE id=1')
                    raise RuntimeError('growth database fault')
                with patch.object(growth,'_award',side_effect=failed), patch.object(growth.log,'exception'):
                    with db.conn() as c: growth.safe_record('sent',key='retry-committed-send',connection=c)
                    assert growth.snapshot() == original
                recovered = growth.snapshot()
                assert recovered['today']['counts']['sent'] == 1
                assert recovered['xp'] == original['xp'] + 10
                assert growth.snapshot() == recovered
            with use(accounts[1]), patch.object(growth.time,'time',return_value=2010):
                b = growth.heartbeat('read-personal-0001',active=10,reading=10,email_id=1)
                assert b['today']['counts']['read'] == a['today']['counts']['read'] + 1
                assert b['today']['counts']['active'] == a['today']['counts']['active'] + 10
                assert growth.heartbeat('read-personal-0001',active=10,reading=10,email_id=1) == b
                # Shared purchase receipts and shared spending across mailboxes.
                with growth.connection() as c: c.execute('UPDATE companion_profile SET xp=1200,stamps=600')
                bought = growth.purchase('berry',token='shared-berry-once')
            with use(accounts[0]):
                assert growth.purchase('berry',token='shared-berry-once') == bought
                assert growth.purchase('scarf')['stamps'] == bought['stamps']
                # Client state lives outside every mailbox. Deleting one cannot reset it.
                Path(accounts[1]['DB_PATH']).unlink()
                assert growth.snapshot() == bought
                with use(accounts[1]):
                    db.init_db()
                    growth.record('received',key='legacy-message')
                    recreated = growth.snapshot()
                    assert recreated['xp'] == bought['xp'] + 2
                    bought = recreated
                assert growth.snapshot() == bought
                export = root / 'companion-export.sqlite3'
                growth.export_store(export)
                growth.record('tool',key='after-backup')
                newer = growth.snapshot()
                growth.import_store(export)
                assert growth.snapshot() == newer  # Old own-client backup cannot rewind progress.
            target = root / 'new-client'
            target.mkdir()
            fresh = dict(ACCOUNT_ID='fresh',DB_PATH=str(target/'mailai.db'),IMAP_USER='fresh@example.test')
            with patch.object(config,'DATA_DIR',str(target)), use(fresh):
                db.init_db()
                growth.import_store(export)
                assert growth.snapshot() == bought
                growth.import_store(export)
                assert growth.snapshot() == bought
                assert growth.purchase('berry',token='shared-berry-once') == bought
            # A damaged unrelated mailbox cannot roll back a completed migration.
            damaged = root / 'accounts' / 'damaged' / 'mailai.db'
            damaged.parent.mkdir(); damaged.write_bytes(b'not a sqlite database')
            with use(accounts[0]), patch.object(growth.log,'exception'):
                assert growth.snapshot() == newer
                growth.record('tool',key='2026-10-10:productivity:advanced_search')
                tool_once = growth.snapshot()
            with use(accounts[1]), patch.object(growth.log,'exception'):
                growth.record('tool',key='2026-10-10:productivity:advanced_search')
                assert growth.snapshot() == tool_once
                growth.record('learn',key='tomorrow',now=now+timedelta(days=1))
                growth.record('sent',key='late-recovery',now=now)
                with growth.connection() as c:
                    assert growth._profile(c)['last_day'] == (now+timedelta(days=1)).date().isoformat()
                    assert growth._profile(c)['streak'] == 2
    print('Client growth: legacy merge, shared caps/IDs/pause/receipts, committed-award recovery and backup migration passed')


if __name__ == '__main__': main()
