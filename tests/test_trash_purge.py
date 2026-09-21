"""Offline local-first purge, durable retry and anti-resurrection tests."""
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, trash_purge as purge, pipeline


class FakeMail:
    def __init__(self):
        self.client = self
        self.messages = {1:b'one', 2:b'two', 3:b'server only'}
        self.validity, self.uidplus = 42, True
        self.deleted, self.fail = [], False
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def _text(self, value): return value.decode() if isinstance(value, bytes) else str(value)
    def list_folders(self): return [([b'\\Trash'], b'/', b'Deleted Items')]
    def has_capability(self, cap): return self.uidplus
    def select_folder(self, folder, readonly=True):
        assert folder == 'Deleted Items'
        return {b'UIDVALIDITY': self.validity}
    def fetch(self, uids, fields):
        return {uid:{b'BODY[]':self.messages[uid]} for uid in uids if uid in self.messages}
    def search(self, criteria): return [uid for uid in map(int, criteria[1].split(',')) if uid in self.messages]
    def add_flags(self, uids, flags, silent=True): assert uids and flags == ['\\Deleted']
    def expunge(self, uids):
        assert uids, 'No mailbox-wide expunge'
        if self.fail: raise OSError('network lost')
        self.deleted.extend(uids)
        for uid in uids: self.messages.pop(uid, None)


def no_network():
    raise AssertionError('Local action must never contact IMAP')


def rejected(fn):
    try: fn()
    except ValueError: return
    raise AssertionError('Unsafe request accepted')


with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', str(Path(root)/'mail.db')), patch.object(config, 'RAW_DIR', root):
    db.init_db()
    db.observe_uid_validity('Deleted Items', 42)
    mail = FakeMail()
    def add(uid, status='trash', folder='Deleted Items'):
        path = Path(root)/f'{uid}.eml'
        path.write_bytes(mail.messages.get(uid, str(uid).encode()))
        return db.upsert_email(dict(uid=uid,folder=folder,status=status,raw_path=str(path),subject=f'Mail {uid}'))
    def remove(ids):
        plan = purge.preview(no_network, ids)
        return purge.execute(no_network, plan['token'], True)
    def due():
        with db.conn() as c: c.execute('UPDATE trash_tombstones SET due_at=0')

    first, second, inbox = add(1), add(2), add(9,'inbox','INBOX')
    rejected(lambda: purge.preview(no_network,[inbox]))
    plan = purge.preview(no_network,[first,first])
    assert plan['count'] == 1
    rejected(lambda: purge.execute(no_network,plan['token'],False))
    with patch.object(config,'IMAP_USER','other@example.test'):
        rejected(lambda: purge.execute(no_network,plan['token'],True))
    assert purge.execute(no_network,plan['token'],True)['completed'] == 1
    assert not db.get_email(first) and not Path(root,'1.eml').exists()
    assert 1 in mail.messages and not mail.deleted
    rejected(lambda: purge.execute(no_network,plan['token'],True))
    assert purge.status()['pending'] == 1
    assert 1 in db.folder_uids('Deleted Items'), 'Skip repeated raw downloads while remote deletion is pending'
    assert db.already_processed('Deleted Items',1)
    # Simulated restart loses all in-memory state, never the persisted work.
    purge._previews.clear()
    db.init_db()
    mail.fail = True
    purge.process_due(lambda:mail)
    assert purge.status()['pending'] == 1 and not db.get_email(first)
    with db.conn() as c:
        task = dict(c.execute('SELECT * FROM trash_tombstones').fetchone())
    assert task['attempts'] == 1 and task['due_at'] > task['created_at'] and task['error']
    # Both import paths reject the deleted message, even if COPY gave it a new UID.
    assert pipeline._store_folder_message('Deleted Items','trash',1,b'one',[]) == 0
    assert pipeline._store_folder_message('Deleted Items','trash',99,b'one',[]) == 0
    assert db.upsert_email(dict(uid=1,folder='Deleted Items',subject='late write')) == 0
    mail.fail = False
    due(); purge.process_due(lambda:mail)
    assert mail.deleted == [1] and purge.status()['pending'] == 0
    assert purge.suppressed('Deleted Items',99,b'one')
    # Empty is a local snapshot. Server-only mail and later local arrivals survive.
    plan = purge.preview(no_network,[],True)
    assert plan['count'] == 1
    later = add(4)
    result = purge.execute(no_network,plan['token'],True)
    assert result['completed'] == 1 and not db.get_email(second)
    assert db.get_email(later) and db.get_email(inbox)
    purge.process_due(lambda:mail)
    assert 3 in mail.messages and 2 not in mail.messages
    # UIDVALIDITY changes stop remote deletion, but never roll local deletion back.
    mail.messages[4] = b'4'
    remove([later]); mail.validity = 43
    purge.process_due(lambda:mail)
    assert 4 in mail.messages and purge.status()['blocked'] == 1
    db.observe_uid_validity('Deleted Items',43,reset=True)
    assert not purge.suppressed('Deleted Items',4,b'new unrelated message')
    assert 4 not in db.folder_uids('Deleted Items'), 'Never retain old UID suppression across a generation reset'
    assert db.upsert_email(dict(uid=4,folder='Deleted Items',subject='new generation'))
    # A missing original does not stop local deletion or guess remote identities.
    missing = add(5); Path(root,'5.eml').unlink()
    assert remove([missing])['completed'] == 1
    assert db.upsert_email(dict(uid=55,folder='Deleted Items',subject='Mail 5')) == 0
    # Rows restored after preview must survive; failed/active remote moves do not block purge.
    restored = add(6)
    plan = purge.preview(no_network,[restored])
    db.set_status(restored,'inbox')
    assert purge.execute(no_network,plan['token'],True)['completed'] == 0
    for uid, phase in enumerate(('trash', 'trash_copying', 'trash_copied', 'trash_locating'), 70):
        moving = add(uid, 'inbox', 'INBOX')
        with db.conn() as c:
            c.execute("UPDATE emails SET pending_action=?,pending_error='network failed' WHERE id=?", (phase,moving))
        plan = purge.preview(no_network,[moving])
        assert plan['count'] == 1 and plan['skipped'] == 0
        with db.conn() as c:
            c.execute("UPDATE emails SET pending_action='trash_locating' WHERE id=?", (moving,))
        assert purge.execute(no_network,plan['token'],True)['completed'] == 1
        assert not db.get_email(moving)
        assert not db.finish_trash_action(moving, 'Deleted Items', 900 + uid)
        assert db.upsert_email(dict(uid=900+uid,folder='Deleted Items',subject=f'Mail {uid}')) == 0
    # A late worker must not modify another existing canonical row after purge.
    survivor = add(80, 'inbox')
    assert not db.finish_trash_action(moving, 'Deleted Items', 80)
    assert db.get_email(survivor)['status'] == 'inbox'
    from app.trash_queue import _still_pending
    assert _still_pending([dict(id=moving,pending_action='trash_copied')]) == []
    # A failed unlink is durable and does not restore the deleted mail.
    stuck = add(8)
    with patch.object(Path,'unlink',side_effect=PermissionError('fixture locked')):
        result = remove([stuck])
        assert result['completed'] == 1 and result['cleanup_pending'] == 1
    purge.cleanup_files()
    assert not Path(root,'8.eml').exists() and purge.status()['cleanup_pending'] == 0
    # Transaction rollback cannot leave a tombstone without its matching deletion.
    atomic = add(10)
    plan = purge.preview(no_network,[atomic])
    with patch.object(purge,'_remove_local',side_effect=RuntimeError('crash before commit')):
        try: purge.execute(no_network,plan['token'],True)
        except RuntimeError: pass
        else: raise AssertionError('Expected injected failure')
    assert db.get_email(atomic) and not purge.suppressed('Deleted Items',10,b'10')
    # Another account cannot consume jobs or inherit suppression markers.
    with patch.object(config,'IMAP_USER','other@example.test'):
        assert purge.status()['pending'] == 0
        assert not purge.suppressed('Deleted Items',99,b'one')
        purge.process_due(no_network)
    # Lack of UIDPLUS never permits broad EXPUNGE.
    mail.validity = 43; mail.uidplus = False
    due(); before = list(mail.deleted); purge.process_due(lambda:mail)
    assert mail.deleted == before

    # A blocked remote connection must not hold the local deletion or DB lock.
    mail.uidplus = True
    mail.messages[11] = b'11'
    slow, local = add(11), add(12)
    remove([slow])
    entered, release = threading.Event(), threading.Event()
    original_fetch = mail.fetch
    def stalled_fetch(*args):
        entered.set()
        assert release.wait(5)
        return original_fetch(*args)
    failures = []
    def worker():
        try: purge.process_due(lambda:mail)
        except Exception as exc: failures.append(exc)
    with patch.object(mail,'fetch',side_effect=stalled_fetch):
        thread = threading.Thread(target=worker)
        thread.start()
        assert entered.wait(2)
        try:
            assert remove([local])['completed'] == 1
            assert db.get_email(inbox), 'Reading unrelated mail remains available'
        finally:
            release.set(); thread.join(5)
        assert not thread.is_alive() and not failures

print('Local-first purge: offline operation, durable retries, identity protection, local-only snapshot, anti-resurrection, rollback and file recovery passed')
