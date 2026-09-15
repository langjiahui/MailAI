"""Offline process recovery and indexed-search parity, including legacy migration."""
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def stuck(output, attachment, page):
    time.sleep(60)


def crashed(output, attachment, page):
    os._exit(3)


def main():
    from app import db
    from app.account_context import use
    from app.preview_worker import preview_isolated
    from app.mail_search import expression
    attachment = {'name': 'sample.txt', 'payload': b'hello'}
    before = {child.pid for child in multiprocessing.active_children()}
    start = time.monotonic()
    assert '超时' in preview_isolated(attachment, timeout=0.2, worker=stuck)['message']
    assert time.monotonic() - start < 5
    assert '异常退出' in preview_isolated(attachment, worker=crashed)['message']
    assert preview_isolated(attachment)['text'] == 'hello'
    assert {child.pid for child in multiprocessing.active_children()} == before
    with tempfile.TemporaryDirectory() as directory, use({'ACCOUNT_ID':'test', 'DB_PATH':str(Path(directory)/'mail.db')}):
        # Start with an existing database, then let the normal initializer migrate.
        with db.conn() as c:
            c.executescript(db.SCHEMA)
            c.execute("INSERT INTO emails(uid,subject,body_text,date) VALUES(1,'项目验收通知','合同 review abcdef 100% a_b','2026-09-08')")
        db.init_db()
        db.init_db()  # No repeated rebuild or duplicate triggers.
        second = db.upsert_email({'uid':2, 'subject':'中文检索 abcxyz', 'body_text':'other text', 'date':'2026-09-07'})
        def parity():
            for terms in [['项目验收'], ['合同'], ['项'], ['ABC'], ['abc','中文检索'], ['100%'], ['a_b'], ['不存在'], ['验收通知','合同'], ['" OR x'], ['abc','abc']]:
                cleaned = [term.lower() for term in terms]
                for offset in [0,1]:
                    with db.conn() as c:
                        where = ' OR '.join(expression() + ' LIKE ?' for _ in terms)
                        expected = [r[0] for r in c.execute(f'SELECT id FROM emails WHERE remote_missing=0 AND ({where}) ORDER BY date DESC,id DESC LIMIT 1 OFFSET ?', [*[f'%{t}%' for t in cleaned], offset])]
                    actual = [r['id'] for r in db.search_emails(terms, limit=1, offset=offset)]
                    assert actual == expected, (terms, expected, actual)
        parity()
        with db.conn() as c:
            c.execute('UPDATE emails SET body_text=?,subject=? WHERE id=?', ('项目验收', 'changed', second))
        parity()
        with db.conn() as c:
            c.execute('DELETE FROM emails WHERE id=?', (second,))
        parity()
        with db.conn() as c:
            c.execute("INSERT INTO email_search(email_search,rank) VALUES('integrity-check',1)")
            # An older runtime with no index must continue returning correct mail.
            for name in ['email_search_insert','email_search_update','email_search_delete']:
                c.execute(f'DROP TRIGGER {name}')
            c.execute('DROP TABLE email_search')
        parity()
    print('PASS preview timeout/crash/recovery; indexed search migration/update/delete/short Chinese/wildcards/pagination/fallback')


if __name__ == '__main__':
    main()
