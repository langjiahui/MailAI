"""Task extraction identity, conservative notice grouping and atomic reminders."""
from datetime import datetime, timedelta
from pathlib import Path
import sys
import tempfile
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, task_planner, todo_grouping, task_notifications
from app.account_context import use


def test_groups():
    def row(id, email, subject='部门秋季出行安排通知', **fields):
        return dict(id=id, email_id=email, email_subject=subject, title='核对安排',
                    email_date='2026-10-22T09:00:00', email_from='同事 <team@example.test>',
                    deadline='2026-10-23', status='open', **fields)
    items = [row(1, 1), row(2, 1), row(3, 2, '请以此邮件为准！部门秋季出行安排通知'),
             row(4, 3), row(5, 4, '项目更新周报邮件通知'), row(6, 5, '项目更新周报邮件通知')]
    grouped = todo_grouping.annotate(items)
    assert grouped[0]['group_key'] == grouped[1]['group_key'] == grouped[2]['group_key']
    assert grouped[3]['group_key'] == grouped[0]['group_key']  # same event as the explicit correction
    assert grouped[4]['group_key'] != grouped[5]['group_key'], 'Same routine subject is not proof of a revision'
    assert grouped[2]['group_title'] == '部门秋季出行安排通知'
    for change in ({'deadline':'2026-10-24'}, {'stage':'waiting'}, {'kind':'decision'},
                   {'email_from':'other@example.test'}, {'email_date':'2026-10-10T09:00:00'},
                   {'email_date':''}, {'email_subject':'请以此邮件为准！其他出行安排通知'}):
        values = todo_grouping.annotate([items[0], {**items[2], **change}])
        assert values[0]['group_key'] != values[1]['group_key'], change
    # Explicit threads still retain separate deadline groups.
    values = todo_grouping.annotate([{**items[0],'email_thread':'t'}, {**items[4],'email_thread':'t'}])
    assert values[0]['group_key'] == values[1]['group_key']
    values = todo_grouping.annotate([{**items[0], 'email_id':None}, {**items[1], 'email_id':None}])
    assert values[0]['group_key'] != values[1]['group_key']
    # Weekly repeats must not form an unbounded chain via corrections.
    values = todo_grouping.annotate([items[0], {**items[2], 'email_date':'2026-10-29T09:00:00'},
                                    {**items[3], 'email_date':'2026-10-15T09:00:00'}])
    assert values[0]['group_key'] == values[1]['group_key'] != values[2]['group_key']


def main():
    test_groups()
    with tempfile.TemporaryDirectory() as root:
        settings = dict(ACCOUNT_ID='group-test', DB_PATH=str(Path(root)/'a.db'), IMAP_USER='me@example.test')
        with use(settings):
            db.init_db()
            eid = db.upsert_email(dict(uid=1, subject='示例活动通知', status='inbox'))
            suggestions = [{'title':'核对出行安排。', 'deadline':'2026-10-23'},
                           {'title':' 核对出行安排 ', 'deadline':'2026-10-23'},
                           {'title':'携带雨具', 'deadline':'2026-10-23'}]
            db.refresh_generated_todos(eid, suggestions)
            before = {row['id']:row for row in db.list_todos(True)}
            assert len(before) == 2
            db.refresh_generated_todos(eid, list(reversed(suggestions)))
            assert {row['id'] for row in db.list_todos(True)} == set(before), 'Refresh must preserve task identity'
            db.add_todos(eid, suggestions)
            assert len(db.list_todos(True)) == 2
            ids = sorted(before)
            when = datetime.now()+timedelta(days=2)
            assert task_planner.save_group_reminder(ids, when.isoformat()) == 2
            rows = db.list_todos(True)
            assert len({row['remind_at'] for row in rows}) == 1
            # Existing scheduler submits one combined notification, not one per subtask.
            sent = []
            account = {'db_path':settings['DB_PATH'], 'user':settings['IMAP_USER']}
            assert task_notifications.dispatch_account('group-test',account,when+timedelta(seconds=1),
                lambda *args: (sent.append(args), True)[1]) == 2
            assert len(sent) == 1
            assert task_notifications.dispatch_account('group-test',account,when+timedelta(seconds=2),
                lambda *args: (_ for _ in ()).throw(AssertionError('Duplicate notification'))) == 0
            db.set_todo_status(ids[0],'done')
            for invalid_ids, value in [(ids, when.isoformat()), ([ids[1],999],''), ([ids[1]],'invalid'),
                                       ([ids[1]],'2000-01-01T09:00:00')]:
                original = db.list_todos(True)
                try: task_planner.save_group_reminder(invalid_ids,value)
                except ValueError: pass
                else: raise AssertionError((invalid_ids,value))
                assert db.list_todos(True) == original, 'Failed bulk changes must be atomic'
            task_planner.save_group_reminder([ids[1]],'')
            assert not any(row['remind_at'] for row in db.list_todos(True))
            db.refresh_generated_todos(eid,[{'title':'模型重提取，不应覆盖用户安排'}])
            assert {row['id'] for row in db.list_todos(True)} == set(ids)
            db.add_todos(eid,suggestions)
            assert len(db.list_todos(True)) == 2, 'Completed tasks must not reappear on extraction'
            eid2 = db.upsert_email(dict(uid=2,subject='并发去重'))
            eid3 = db.upsert_email(dict(uid=3,subject='用户确认的任务'))
            db.refresh_generated_todos(eid3,[{'title':'用户明确创建的跟进'}])
            db.add_todos(eid3,[{'title':'用户明确创建的跟进'}],user_edited=True)
            db.refresh_generated_todos(eid3,[{'title':'模型不应替换用户确认的事项'}])
            assert next(row for row in db.list_todos(True) if row['email_id']==eid3)['title']=='用户明确创建的跟进'
        errors=[]
        def worker():
            try:
                with use(settings): db.add_todos(eid2,[{'title':'确认排期'}])
            except Exception as exc: errors.append(exc)
        workers=[threading.Thread(target=worker) for _ in range(4)]
        for worker_thread in workers: worker_thread.start()
        for worker_thread in workers: worker_thread.join()
        assert not errors, errors
        with use(settings):
            assert len([row for row in db.list_todos(True) if row['email_id']==eid2]) == 1
        with use(dict(ACCOUNT_ID='other',DB_PATH=str(Path(root)/'b.db'))):
            db.init_db()
            try: task_planner.save_group_reminder(ids, when.isoformat())
            except ValueError: pass
            else: raise AssertionError('Cross-account group mutation')
    print('PASS conservative task groups, extraction idempotence, original IDs, atomic reminders, one notification and account isolation')


if __name__ == '__main__': main()
