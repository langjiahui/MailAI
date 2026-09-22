"""Progress facts must remain account-bound, conservative and read-only."""
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db, conversation_progress as progress, task_planner
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as root:
        context = dict(ACCOUNT_ID='a', DB_PATH=str(Path(root)/'a.db'), IMAP_USER='me@example.test')
        with use(context):
            db.init_db()
            def mail(uid, mid, parent='', refs='', **kw):
                return db.upsert_email(dict(uid=uid, message_id=mid, in_reply_to=parent,
                    references_header=refs, thread_id=parent or mid, subject='采购确认',
                    date=f'2026-09-22T10:{uid:02d}:00+08:00', from_addr='client@example.test',
                    status='inbox', body_text='请核对新安排。\n> 已引用的旧安排', **kw))
            first = mail(1, '<a@example.test>')
            second = mail(2, '<b@example.test>', '<a@example.test>')
            third = mail(3, '<c@example.test>', '<b@example.test>', '<a@example.test> <b@example.test>')
            unrelated = mail(4, '<unrelated@example.test>')
            hidden = mail(5, '<removed@example.test>', '<a@example.test>')
            with db.conn() as c:
                c.execute('UPDATE emails SET remote_missing=1 WHERE id=?', (hidden,))
            with db.conn() as c:
                c.execute("UPDATE emails SET verdict='suspicious',reviewed=1 WHERE id=?", (first,))
            before = db.mailbox_revision()
            result = progress.build(third)
            assert {row['id'] for row in result['timeline']} == {first, second, third}
            assert unrelated not in {row['id'] for row in result['timeline']}
            assert result['status'] == '处理状态待确认'
            assert not next(row for row in result['timeline'] if row['id']==first)['risky']
            assert '已引用' not in result['timeline'][0]['excerpt']
            assert db.mailbox_revision() == before
            # Successful local replies count before IMAP sync; failed sends and forwards do not.
            payload = dict(from_addr='me@example.test', to_addr='client@example.test', subject='Re: 采购确认',
                body_html='<p>已收到，稍后确认。</p>', reply_to_email_id=third,
                in_reply_to='<c@example.test>', references='<a@example.test> <b@example.test> <c@example.test>', mode='reply')
            failed = db.create_sent_message(payload)
            db.finish_sent_message(failed, ok=False)
            sent = db.create_sent_message(payload)
            db.finish_sent_message(sent, ok=True, message_id='<sent@example.test>')
            forwarded = db.create_sent_message(dict(payload, mode='forward'))
            db.finish_sent_message(forwarded, ok=True, message_id='<forward@example.test>')
            result = progress.build(first)
            assert [row['id'] for row in result['timeline'] if row['source'] == 'sent'] == [sent]
            assert result['status'] == '处理状态待确认'
            db.add_todos(first, [{'title':'自动识别任务'}])
            assert progress.build(first)['status'] == '处理状态待确认'
            task = task_planner.save(email_id=second, title='等对方确认', stage='waiting')
            assert progress.build(third)['status'] == '已标记等待反馈'
            db.set_todo_status(task['id'], 'done')
            result = progress.build(third)
            assert result['status'] == '已记录任务完成'
            assert '是否结束' in result['next_step']
            # Synced copy shares a Message-ID and must not double count the successful local send.
            copy = mail(6, '<sent@example.test>', '<c@example.test>')
            assert progress.build(first)['linked_count'] == 4
            assert sum(row['current'] for row in progress.build(copy)['timeline']) == 1
            duplicate = mail(7, '<b@example.test>', '<a@example.test>')
            assert progress.build(first)['linked_count'] == 4, 'Copies in multiple folders are not separate messages'
            assert sum(row['current'] for row in progress.build(duplicate)['timeline']) == 1
            # Cap work and clearly report incompleteness instead of claiming a complete thread.
            from unittest.mock import patch
            with patch.object(progress, 'MAX_MESSAGES', 2):
                limited = progress.build(first)
                assert limited['truncated'] and limited['linked_count'] <= 2
            with db.conn() as c:
                c.execute('UPDATE emails SET body_text=? WHERE id=?', ('建议交付从周五改为下周二，请确认。', third))
            tasks_before = db.list_todos(True)
            changes = progress.build(first)['changes']['items']
            assert changes[0]['id'] == third and changes[0]['before'] == '周五'
            assert changes[0]['state'] == 'proposal'
            assert db.list_todos(True) == tasks_before, 'Detecting dates cannot reschedule tasks'
            db.init_db()  # repeat migration preserves reply relationships
            assert db.get_sent_message(sent)['reply_to_email_id'] == third
            assert progress.build(first)['linked_count'] == 4
        with use(dict(ACCOUNT_ID='b', DB_PATH=str(Path(root)/'b.db'), IMAP_USER='other@example.test')):
            db.init_db()
            eid=db.upsert_email(dict(uid=1,message_id='<a@example.test>',subject='另一账号',status='inbox'))
            result=progress.build(eid)
            assert result['linked_count']==1 and result['account_id']=='b' and not result['tasks']
            assert result['timeline'][0]['subject']=='另一账号'
        print('PASS conversation progress: reply chains, no subject guessing, account isolation, sent deduplication, task facts and read-only behavior')


if __name__ == '__main__': main()
