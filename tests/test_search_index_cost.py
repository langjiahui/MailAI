"""Search must not transliterate stored bodies during reads, including upgrades."""
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, mail_search, system_settings
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as directory, use({
        'ACCOUNT_ID': 'search-fixture', 'DB_PATH': str(Path(directory) / 'mail.db'),
    }):
        db.init_db()
        body = '各位同事，项目进度和交付安排请及时确认。' * 28
        with db.conn() as c:
            c.executemany("INSERT INTO emails(uid,subject,from_name,body_text,date,status) VALUES(?,?,?,?,?,'inbox')", [
                (n, '项目通知', '项目同事', body + ('合同验收' if n % 20 == 0 else ''), '2026-10-15')
                for n in range(1, 388)
            ])
            # Reproduce the shipped external index with full pinyin already in
            # its view. This schema must migrate too, not just literal-only FTS.
            for trigger in ('insert', 'update', 'delete'):
                c.execute(f'DROP TRIGGER email_search_{trigger}')
            c.execute('DROP TABLE email_search')
            c.execute('DROP VIEW email_search_source')
            c.execute(f'CREATE VIEW email_search_content AS SELECT id,{mail_search.expression()} AS text FROM emails')
            c.execute("CREATE VIRTUAL TABLE email_search USING fts5(text, content='email_search_content', content_rowid='id', tokenize='trigram')")
            c.execute("INSERT INTO email_search(email_search) VALUES('rebuild')")
        db.init_db()
        db.init_db()
        timings = []
        for query in ('合同', '合同验收', 'hetong', '不存在', 'h_', '%验收'):
            with db.conn() as c:
                calls = []
                c.create_function('mailai_pinyin', 1, lambda text: calls.append(text) or '')
                c.create_function('mailai_body_pinyin', 1, lambda text: calls.append(text) or '')
                where, args = mail_search.predicate(c, [query])
                started = time.perf_counter()
                rows = c.execute(f'SELECT id FROM emails WHERE {where}', args).fetchall()
                timings.append({'query': query, 'seconds': round(time.perf_counter() - started, 4), 'count': len(rows)})
                assert not calls, f'{query}: querying recalculated pinyin for {len(calls)} fields'
                assert len(rows) == (0 if query == '不存在' else 387 if query == 'h_' else 19)
        rows = db.search_emails(['hetong'], list_view=True)
        assert rows[0]['search_match']['highlight'] == '合同'
        assert 'body_text' not in rows[0]
        registry = {'accounts': {'search-fixture': {'db_path': config.DB_PATH, 'user': 'fixture@example.test'}}}
        with patch.object(system_settings, '_load_registry', return_value=registry):
            assert len(system_settings.list_unified_inbox(q='合同')) == 19
        with db.conn() as c:
            c.execute("UPDATE emails SET body_text='新的独特标记' WHERE uid=20")
            c.execute('DELETE FROM emails WHERE uid=40')
            c.execute("INSERT INTO email_search(email_search,rank) VALUES('integrity-check',1)")
        assert len(db.search_emails(['合同'])) == 17
        assert len(db.search_emails(['dutebiaoji'])) == 1
        # A not-yet-migrated account (or SQLite without trigram) must also
        # avoid transliteration for short Chinese queries.
        with db.conn() as c:
            for trigger in ('insert', 'update', 'delete'):
                c.execute(f'DROP TRIGGER email_search_{trigger}')
            c.execute('DROP TABLE email_search')
            calls = []
            c.create_function('mailai_pinyin', 1, lambda text: calls.append(text) or '')
            c.create_function('mailai_body_pinyin', 1, lambda text: calls.append(text) or '')
            where, args = mail_search.predicate(c, ['合同'])
            assert len(c.execute(f'SELECT id FROM emails WHERE {where}', args).fetchall()) == 17
            assert not calls
        print('PASS stored search text: old pinyin-index upgrade, 387 long Chinese bodies, short/wildcard/Latin queries, zero read-time transliteration, write/delete parity')
        print(json.dumps(timings, ensure_ascii=False))


if __name__ == '__main__':
    main()
