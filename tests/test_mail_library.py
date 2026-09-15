"""Offline data regressions for selective recovery, favorites and contact groups."""
import os
import sys
import tempfile
import sqlite3
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, system_settings
from app.web import server


def main():
    with tempfile.TemporaryDirectory() as td, patch.multiple(config, DATA_DIR=td, DB_PATH=td+'/mail.db', RAW_DIR=td+'/raw', IMAP_USER='fixture@example.test', IMAP_HOST='imap.example.test'):
        Path(config.RAW_DIR).mkdir()
        db.init_db()
        for uid, date in [(1,'2026-08-31T23:59:59'), (2,'2026-09-01T00:00:00'), (3,'2026-09-02T23:59:59'), (4,'2026-09-03T00:00:00')]:
            raw = Path(config.RAW_DIR)/f'{uid}.eml'; raw.write_text(f'original attachment {uid}')
            db.upsert_email(dict(uid=uid, folder='INBOX', message_id=f'<{uid}@test>', subject=f'Original {uid}', date=date, raw_path=str(raw)))
        server.api_set_email_favorite(2, True)
        assert db.get_email(2)['is_favorite'] == 1
        db.sync_mail_flags(2, is_read=False, is_starred=False)
        assert db.get_email(2)['is_favorite'] == 1, 'server flags must not clear local favorites'
        db.save_contact_group('研发组')
        server.api_save_contact(server.ContactRequest(email='person@example.test', name='张三', company='研发', group_name='研发组'))
        db.save_contact_group('项目组','研发组')
        assert db.search_contacts()[0]['group_name'] == '项目组'
        db.save_contact_group('空分组'); assert len(db.list_contact_groups()) == 2
        db.update_contact_group_members('空分组', ['person@example.test','PERSON@example.test'])
        person = db.search_contacts('person@example.test')[0]
        assert person['group_name'] == '空分组' and person['name'] == '张三' and person['company'] == '研发'
        db.update_contact_group_members('空分组', ['person@example.test'], remove=True)
        assert db.search_contacts('person@example.test')[0]['group_name'] == ''
        db.update_contact_group_members('项目组', ['person@example.test'])
        try: db.update_contact_group_members('空分组', ['person@example.test','missing@example.test'])
        except ValueError: pass
        else: raise AssertionError('nonexistent contact accepted')
        assert db.search_contacts('person@example.test')[0]['group_name'] == '项目组'
        with db.conn() as c:
            c.execute("UPDATE emails SET from_addr='learned@example.test',from_name='历史人员' WHERE id=1")
        db.update_contact_group_members('空分组', ['learned@example.test'])
        assert db.search_contacts('learned@example.test')[0]['name'] == '历史人员'
        db.update_contact_group_members('空分组', ['learned@example.test'], remove=True)

        try: db.save_contact_group('项目组')
        except ValueError: pass
        else: raise AssertionError('duplicate group accepted')
        backup = system_settings.create_backup(True)
        with db.conn() as c:
            c.execute("UPDATE emails SET subject='Current',is_favorite=0")
            c.execute('DELETE FROM emails WHERE id=3')
            c.execute("INSERT INTO outbox(token,payload,status,due_at,created_at,updated_at) VALUES('preserve','{}','queued','','','')")
        Path(config.RAW_DIR,'3.eml').unlink()
        Path(config.RAW_DIR,'2.eml').write_text('changed raw')
        db.save_contact_group('新增组')
        for start,end in [('2026-09-03','2026-09-01'),('bad','2026-09-01'),('2025-01-01','2025-01-02')]:
            try: system_settings.restore_backup(backup['filename'],start_date=start,end_date=end)
            except ValueError: pass
            else: raise AssertionError('invalid/empty range accepted')
            assert db.get_email(2)['subject'] == 'Current'
        original_copy = system_settings._copy_database
        def fail_commit(src,dst):
            if src.endswith('merged.db') and dst == config.DB_PATH: raise OSError('injected write failure')
            return original_copy(src,dst)
        with patch.object(system_settings,'_copy_database',side_effect=fail_commit):
            try: system_settings.restore_backup(backup['filename'],start_date='2026-09-01',end_date='2026-09-02')
            except OSError: pass
            else: raise AssertionError('failure expected')
        assert db.get_email(2)['subject'] == 'Current'
        assert Path(config.RAW_DIR,'2.eml').read_text() == 'changed raw'
        result=system_settings.restore_backup(backup['filename'],start_date='2026-09-01',end_date='2026-09-02')
        assert result['restored_count'] == 2 and Path(system_settings.backup_path(result['safety_backup'])).is_file()
        rows=db.list_emails(days=9999)
        assert len(rows)==4
        assert db.get_email(1)['subject']=='Current' and db.get_email(4)['subject']=='Current'
        restored=next(r for r in rows if r['uid']==3)
        assert Path(restored['raw_path']).read_text()=='original attachment 3'
        assert Path(db.get_email(2)['raw_path']).read_text()=='original attachment 2'
        assert db.get_email(2)['is_favorite']==1
        assert any(g['name']=='新增组' for g in db.list_contact_groups())
        with db.conn() as c: assert c.execute("SELECT status FROM outbox WHERE token='preserve'").fetchone()[0]=='queued'
        system_settings.restore_backup(backup['filename'],start_date='2026-09-01',end_date='2026-09-02')
        assert len(db.list_emails(days=9999))==4, 'repeat recovery duplicated mail'
        system_settings.restore_backup(backup['filename'])
        assert db.get_email(1)['subject']=='Original 1'
        assert not any(g['name']=='新增组' for g in db.list_contact_groups())
        db.delete_contact_group('项目组')
        assert db.search_contacts('person@example.test')[0]['group_name']==''
        # Group filtering must precede the 300-row limit.
        for index in range(305): db.save_contact(f'a{index:03}@example.test')
        server.api_save_contact(server.ContactRequest(email='z-last@example.test',group_name='尾部分组'))
        assert db.search_contacts(limit=300,group_name='尾部分组')[0]['email']=='z-last@example.test'
        with db.conn() as c: c.execute("UPDATE emails SET message_id='<collision>' WHERE id=2")
        try: system_settings.restore_backup(backup['filename'],start_date='2026-09-01',end_date='2026-09-02')
        except ValueError: pass
        else: raise AssertionError('UID collision accepted')
        assert db.get_email(2)['message_id']=='<collision>'
        db.init_db(); assert db.get_email(2)['is_favorite']==1
        server.api_set_email_favorite(2,False); assert not db.get_email(2)['is_favorite']
    print('PASS selective/full backup restore, rollback, date boundaries, raw attachments, favorites and groups')

class TrackedRestoreCursor(sqlite3.Cursor):
    explicitly_closed = False

    def close(self):
        self.explicitly_closed = True
        return super().close()


class TrackedRestoreConnection(sqlite3.Connection):
    restore_cursor = None

    def execute(self, sql, parameters=()):
        if sql.startswith('SELECT * FROM emails WHERE substr('):
            self.restore_cursor = self.cursor(factory=TrackedRestoreCursor)
            return self.restore_cursor.execute(sql, parameters)
        return super().execute(sql, parameters)

    def close(self):
        try:
            # Windows cannot unlink the DB while an unfinished SELECT still
            # holds a native statement, even after Connection.close().
            if self.restore_cursor is not None:
                assert self.restore_cursor.explicitly_closed, 'Restore SELECT cursor retained at connection close'
        finally:
            super().close()


if __name__=='__main__':
    original_connect = sqlite3.connect
    def tracked_connect(*args, **kwargs):
        return original_connect(*args, **dict(kwargs, factory=TrackedRestoreConnection))
    with patch.object(system_settings.sqlite3, 'connect', side_effect=tracked_connect):
        main()

