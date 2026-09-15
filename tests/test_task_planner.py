"""Same task through briefing, reminders, completion, migration and concurrent adds."""
import sys, tempfile, json, threading
from pathlib import Path
from datetime import datetime, timedelta
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import db, task_planner, secretary
from app.account_context import use

def main():
    with tempfile.TemporaryDirectory() as root:
        values=dict(ACCOUNT_ID='a',DB_PATH=str(Path(root)/'a.db'),IMAP_USER='a@example.test')
        with use(values):
            db.init_db()
            eid=db.upsert_email(dict(uid=1,subject='请确认交付',date=datetime.now().isoformat(),status='inbox',verdict='clean'))
            future=(datetime.now()+timedelta(days=2)).isoformat(timespec='seconds')
            task=task_planner.save(email_id=eid,title='确认交付方案',deadline='',kind='decision',remind_at=future)
            assert task_planner.save(email_id=eid,title='重复创建')['id']==task['id']
            assert db.list_todos()[0]['title']=='确认交付方案'
            db.refresh_generated_todos(eid,[{'title':'模型重新提取'}])
            assert db.list_todos()[0]['id']==task['id'] and db.list_todos()[0]['title']=='确认交付方案'
            task_planner.save(todo_id=task['id'],stage='waiting',deadline=future[:10])
            groups={g['key']:g for g in secretary.briefing()['groups']}
            assert groups['waiting']['items'][0]['todo_id']==task['id']
            assert not groups['attention']['items'] and not groups['tasks']['items']
            db.set_todo_status(task['id'],'done')
            assert not any(g['items'] for g in secretary.briefing()['groups'])
            assert not db.list_todos(True)[0]['remind_at']
            assert task_planner.save(email_id=eid)['status']=='done', 'Completed source cannot silently create another task'
            db.set_todo_status(task['id'],'open')
            task_planner.save(todo_id=task['id'],stage='active',deadline='',remind_at=future)
            db.set_todos_status([task['id']],'done')
            assert not db.list_todos(True)[0]['remind_at']
            db.set_todo_status(task['id'],'open')
            db.set_runtime_setting('mail_reminders',json.dumps({str(eid):{'at':future,'subject':'旧提醒'}}))
            db.init_db();db.init_db()
            assert len(db.list_todos(True))==1
            assert db.list_todos()[0]['remind_at']==future
            assert json.loads(db.get_runtime_settings()['mail_reminders'])=={}
            for fields in ({'stage':'boss'},{'deadline':'2026-02-31'},{'title':' '},{'remind_at':'yesterday'}):
                try: task_planner.save(todo_id=task['id'],**fields)
                except ValueError: pass
                else: raise AssertionError(fields)
            eid2=db.upsert_email(dict(uid=2,subject='并发任务',date=datetime.now().isoformat()))
        results=[];errors=[]
        def worker():
            try:
                with use(values):results.append(task_planner.save(email_id=eid2)['id'])
            except Exception as e:errors.append(e)
        workers=[threading.Thread(target=worker) for _ in range(4)]
        for t in workers:t.start()
        for t in workers:t.join()
        assert not errors,errors
        assert len(set(results))==1
        with use(dict(ACCOUNT_ID='b',DB_PATH=str(Path(root)/'b.db'),IMAP_USER='b@example.test')):
            db.init_db()
            try:task_planner.save(todo_id=task['id'],title='wrong account')
            except ValueError:pass
            else:raise AssertionError('Cross-account task mutation')
    print('Unified task identity, waiting, completion, reminder migration, validation and race safety passed')

if __name__=='__main__':main()
