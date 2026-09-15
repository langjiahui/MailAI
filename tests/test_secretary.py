"""Isolated work briefing: conservative suggestions, scope and no side effects."""
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db, secretary, mail_assistant
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as root:
        with use(dict(ACCOUNT_ID='a', DB_PATH=str(Path(root)/'a.db'), IMAP_USER='a@example.test')):
            db.init_db()
            today = datetime.now().isoformat()
            old = (datetime.now()-timedelta(days=20)).isoformat()
            def add(uid, subject, **kw):
                return db.upsert_email(dict(uid=uid, subject=subject, date=kw.pop('date',today), status=kw.pop('status','inbox'), verdict=kw.pop('verdict','clean'), **kw))
            execution = add(1,'请提交项目排期')
            decision = add(2,'请审批预算')
            risky = add(3,'请确认并立即付款', verdict='phishing', score=85)
            historical = add(4,'请提交历史材料', date=old)
            add(5,'请审批隔离邮件',status='quarantine')
            gone = add(6,'请审批已移除邮件')
            with db.conn() as c: c.execute('UPDATE emails SET remote_missing=1 WHERE id=?',(gone,))
            db.add_todos(historical,[{'title':'历史事项仍待办','deadline':old[:10]}])
            before=db.mailbox_revision()
            result=secretary.briefing()
            groups={g['key']:g for g in result['groups']}
            assert [x['email_id'] for x in groups['attention']['items']]==[execution]
            assert [x['email_id'] for x in groups['safety']['items']]==[risky]
            assert not groups['tasks']['items']
            assert groups['history']['items'][0]['email_id']==historical
            assert '历史逾期' in groups['history']['items'][0]['reason']
            assert '不代表尚未回复' in result['note']
            leader=secretary.briefing('decision')
            assert next(g for g in leader['groups'] if g['key']=='attention')['items'][0]['email_id']==decision
            assert db.mailbox_revision()==before, 'Opening briefing must not mark read or create tasks'
            assert len(db.list_todos())==1
            assert historical not in [r['id'] for r in secretary.question_sources('给我工作简报')]
            assert secretary.question_sources('查找张三上周的决策邮件') is None
            assert decision in [r['id'] for r in mail_assistant._sources('有哪些需要我决策的邮件',None)]
            assert [r['id'] for r in mail_assistant._sources('给我工作简报',[execution])]==[execution], 'Explicit scope wins'
            try: secretary.briefing('administrator')
            except ValueError: pass
            else: raise AssertionError('Unknown role must be rejected')
            sample=db.get_email(execution)
            with patch.object(db,'list_emails',return_value=[sample]*301):
                assert secretary.briefing()['truncated']
                assert secretary.briefing()['scanned']==300
            # Task dates, not source-mail dates, determine the daily agenda.
            baseline=datetime.now().date()
            def task(uid, deadline='', remind_at=None, stage='active', status='open'):
                eid=add(uid, '任务来源'+str(uid),date='2022-04-18T09:00:00')
                db.add_todos(eid,[{'title':'安排'+str(uid),'deadline':deadline}])
                with db.conn() as c:
                    c.execute('UPDATE todos SET remind_at=?,stage=?,status=? WHERE email_id=?',(remind_at,stage,status,eid))
                return eid
            due=task(10,baseline.isoformat())
            seven=task(11,(baseline-timedelta(days=7)).isoformat())
            eight=task(12,(baseline-timedelta(days=8)).isoformat())
            undated=task(13)
            future=task(14,(baseline+timedelta(days=1)).isoformat())
            reminded=task(15,'2022-04-29',baseline.isoformat()+'T09:00:00')
            undated_reminded=task(16,remind_at=baseline.isoformat()+'T23:00:00')
            waiting_today=task(17,baseline.isoformat(),stage='waiting')
            waiting_future=task(18,(baseline+timedelta(days=1)).isoformat(),stage='waiting')
            done=task(19,baseline.isoformat(),status='done')
            expired_reminder=task(20,remind_at=(baseline-timedelta(days=1)).isoformat()+'T09:00:00')
            invalid=task(21,'not a date',remind_at='invalid')
            snapshot=db.list_todos(True)
            groups={g['key']:g for g in secretary.briefing()['groups']}
            ids=lambda key: {i['email_id'] for i in groups[key]['items']}
            assert ids('tasks')=={due,seven,reminded,undated_reminded,waiting_today}
            assert ids('history')=={historical,eight}
            assert ids('waiting')=={waiting_future}
            assert not {undated,future,done,expired_reminder,invalid} & set.union(*(ids(k) for k in groups))
            assert groups['tasks']['items'][-1]['email_id']==seven, 'Today before recent overdue'
            assert db.list_todos(True)==snapshot, 'Aging never deletes or completes tasks'
            assert historical not in [r['id'] for r in secretary.question_sources('我先处理什么')]
            with db.conn() as c:
                c.execute('UPDATE todos SET deadline=? WHERE email_id=?',(baseline.isoformat(),historical))
            groups={g['key']:g for g in secretary.briefing()['groups']}
            assert historical in ids('tasks') and historical not in ids('history'), 'Reschedule promotes same task'
        with use(dict(ACCOUNT_ID='b', DB_PATH=str(Path(root)/'b.db'), IMAP_USER='b@example.test')):
            db.init_db()
            assert not any(g['count'] for g in secretary.briefing()['groups']), 'No cross-account leak'
    print('Secretary scope, evidence, task aging, safety split, natural-language routing and account isolation passed')


if __name__=='__main__': main()
