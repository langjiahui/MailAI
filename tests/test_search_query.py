"""Shared query interpretation must preserve literal text and hard filters."""
import sys
import tempfile
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, productivity, system_settings
from app.account_context import use
from app.search_query import expand_natural_query, interpret_query


def main():
    cases = {
        '发件人是方君': {'sender':'方君'},
        '寄件人为方君': {'sender':'方君'},
        '来自方君的邮件': {'sender':'方君'},
        '方君发来的邮件': {'sender':'方君'},
        '请帮我找一下方君发来的邮件': {'sender':'方君'},
        '帮我搜索 发件人是方君': {'sender':'方君'},
        '发给李明的邮件': {'recipient':'李明'},
        '收件人：李明': {'recipient':'李明'},
        '标题包含合同': {'subject':'合同'},
        '文件名是.pdf': {'filename':'.pdf'},
        '发件人是"John Smith"，主题包含"项目 计划"': {'sender':'John Smith','subject':'项目 计划'},
        '发送人是方君并且标题包含合同，带附件 未读': {'sender':'方君','subject':'合同','has_attachment':True,'unread':True},
    }
    for query, expected in cases.items():
        parsed = interpret_query(query)
        assert parsed['structured'], query
        assert not parsed['criteria']['terms'], parsed
        assert all(parsed['criteria'].get(key) == value for key,value in expected.items()), parsed
        replay = interpret_query(parsed['canonical'])
        readable = interpret_query(parsed['display_query'])
        for key,value in expected.items():
            assert replay['criteria'][key] == value, (query,replay)
            assert readable['criteria'][key] == value, (query,readable)
    for phrase, start, end in [('上个月','2026-09-01','2026-09-30'),('上周','2026-10-05','2026-10-11'),
                               ('最近7天','2026-10-09','2026-10-15'),('昨天','2026-10-14','2026-10-14'),
                               ('今年','2026-01-01','2026-10-15'),('去年','2025-01-01','2025-12-31')]:
        expanded = expand_natural_query(phrase,today=date(2026,10,15))
        assert expanded == f'after:{start} before:{end}', expanded
    assert expand_natural_query('上个月',today=date(2026,1,5)) == 'after:2025-12-01 before:2025-12-31'
    assert expand_natural_query('上个月',today=date(2024,3,5)) == 'after:2024-02-01 before:2024-02-29'
    for query in ['没有附件','不是方君','未读懂合同',"O'Reilly",'项目合同','搜索引擎']:
        assert not interpret_query(query)['structured'], query
    quoted = interpret_query('"发件人是方君"')
    assert not quoted['structured'] and quoted['criteria']['terms'] == ['发件人是方君']
    assert interpret_query('subject:"昨天 有附件"')['criteria']['subject'] == '昨天 有附件'
    for query in ['in:sent state:waiting','after:2026-10-01 before:2026-10-15','category:项目工作']:
        parsed = interpret_query(query)
        readable = interpret_query(parsed['display_query'])
        assert [(t['field'],t['value']) for t in parsed['tokens']] == [(t['field'],t['value']) for t in readable['tokens']], readable
    for bad in ['from:', 'from:"未闭合', 'from:甲 from:乙', 'after:2026-10-16 before:2026-10-15']:
        try:
            interpret_query(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(bad)

    with tempfile.TemporaryDirectory() as folder, use({'ACCOUNT_ID':'test','DB_PATH':str(Path(folder)/'mail.db'),'IMAP_USER':'me@example.test'}):
        db.init_db()
        first = db.upsert_email({'uid':1,'status':'inbox','folder':'INBOX','from_addr':'fang@example.test','from_name':'方君',
                                'to_addr':'li@example.test','recipient_names':{'li@example.test':'李明'},
                                'subject':'季度合同','body_text':'合同延期安排','date':'2026-10-15T12:00:00'})
        second = db.upsert_email({'uid':2,'status':'inbox','folder':'Projects','from_addr':'other@example.test','from_name':'其他人',
                                 'subject':'季度合同','date':'2026-10-15T12:00:00'})
        db.upsert_email({'uid':3,'status':'sent','folder':'Sent','from_name':'方君','subject':'季度合同','date':'2026-10-15T12:00:00'})
        from app.web.routes import mail_read, productivity as routes
        with patch('app.semantic.enabled',return_value=True), patch('app.semantic.search',return_value=[second]) as semantic:
            for query in ['发件人是方君','from:fangjun','发给李明的邮件']:
                rows = mail_read.api_search_emails(q=query,status='inbox')
                assert [row['id'] for row in rows] == [first], (query,rows)
                assert 'body_text' not in rows[0]
            semantic.assert_not_called()
        assert mail_read.api_search_emails(q='发件人是方君',status='inbox',folder='Projects') == []
        with patch.object(system_settings,'_load_registry',return_value={'accounts':{'test':{'db_path':str(Path(folder)/'mail.db'),'user':'me@example.test'}}}):
            assert [r['id'] for r in system_settings.list_unified_inbox(q='发件人是方君')] == [first]
            assert [r['id'] for r in system_settings.list_unified_inbox(q='from:fangjun')] == [first]
        draft = db.save_draft({'subject':'计划草稿','body_html':'<p>完整正文</p>','attachments':[{'name':'合同.pdf','data_base64':'PRIVATE'}]})
        result = routes.search({'criteria':{'query':'主题包含计划','mailbox':'drafts'},'mailbox_rows':True})
        row = result['items'][0]
        assert row['id'] == draft and row['_search_summary'] and row['attachments'] == [{'name':'合同.pdf'}]
        assert 'data_base64' not in str(result) and 'body_html' not in row
        remote = productivity.search({'mailbox':'sent','subject':'季度合同'},mailbox_rows=True)['items'][0]
        assert remote['_remote'] and remote['id'] < 0 and remote['remote_email_id'] == -remote['id']
        with db.conn() as c:
            c.execute("UPDATE emails SET remote_missing=1,pending_action='trash_local' WHERE id=?",(first,))
        assert [r['id'] for r in mail_read.api_search_emails(q='发件人是方君',status='trash')] == [first]
    print('PASS query variants, composition, quotes, ordinary prose, calendar boundaries, canonical replay, hard filters, unified scope, mailbox metadata and pending trash')


if __name__ == '__main__':
    main()
