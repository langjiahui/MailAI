"""Slow/broken models must not block mail; cached queries must not leak mail."""
import json
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, semantic
from app.account_context import use

VECTOR = [1.0] + [0.0] * 511


def account(root, name):
    return dict(ACCOUNT_ID=name, DB_PATH=str(Path(root) / (name + '.db')))


def seed():
    db.init_db()
    db.set_runtime_setting('user_preferences', json.dumps({'semantic_enabled': True}))
    email_id = db.upsert_email(dict(uid=1, subject='交付安排', body_text='周五交付'))
    with patch.object(semantic, 'embed_texts', return_value=[VECTOR]):
        semantic.reindex()
    return email_id


def test_automatic_failure_cooldown_and_explicit_rebuild():
    # Run the queued callback synchronously: the test checks scheduling and
    # account state without downloading models or depending on timer races.
    with tempfile.TemporaryDirectory() as root, use(account(root,'cooldown-a')):
        clock=[100.0]
        def start(target, **kwargs):target()
        with patch.object(semantic,'enabled',return_value=True), \
                patch('app.account_guard.start_account_thread',side_effect=start) as spawn, \
                patch.object(semantic,'index_missing',side_effect=ValueError('model unavailable')) as index, \
                patch.object(semantic,'reindex',return_value={'indexed':0}) as rebuild, \
                patch.object(semantic.time,'monotonic',side_effect=lambda:clock[0]), \
                patch.dict(semantic._update_retry_at,{},clear=True), \
                patch.object(semantic.log,'exception') as logged:
            semantic.schedule_missing()
            assert index.call_count==1 and semantic.progress()['error']
            assert not semantic.progress()['running']
            for _ in range(30):semantic.schedule_missing()
            assert spawn.call_count==index.call_count==1, 'New arrivals repeatedly restarted a failed model download'
            assert semantic.progress()['error'], 'Skipped retry erased useful failure state'
            logged.assert_called_once()
            # Failure in one account must not disable indexing in another.
            index.side_effect=None;index.return_value=0
            with use(account(root,'cooldown-b')):
                semantic.schedule_missing()
                assert not semantic.progress()['error']
            assert index.call_count==2
            # The user can explicitly retry immediately after fixing network.
            semantic.schedule_missing(rebuild=True)
            rebuild.assert_called_once_with(background=True)
            assert not semantic.progress()['error']
            assert config.DB_PATH not in semantic._update_retry_at
            semantic.schedule_missing()
            assert index.call_count==3
            # Automatic retry resumes when its deadline expires.
            index.side_effect=ValueError('model unavailable again')
            semantic.schedule_missing()
            clock[0]=399.0
            semantic.schedule_missing()
            assert index.call_count==4
            clock[0]=400.0;index.side_effect=None
            semantic.schedule_missing()
            assert index.call_count==5 and not semantic.progress()['error']
            # A failure to start a worker also releases ownership and backs off.
            spawn.side_effect=RuntimeError('cannot start thread')
            try:semantic.schedule_missing()
            except RuntimeError:pass
            else:raise AssertionError('Worker startup error was hidden')
            calls=spawn.call_count
            spawn.side_effect=start
            semantic.schedule_missing()
            assert spawn.call_count==calls and config.DB_PATH not in semantic._update_pending
            semantic.schedule_missing(rebuild=True)
            assert not semantic.progress()['error']


def main():
    test_automatic_failure_cooldown_and_explicit_rebuild()
    with tempfile.TemporaryDirectory() as root, use(account(root, 'a')):
        email_id = seed()
        with patch.object(semantic, 'embed_texts', return_value=[VECTOR]) as embed:
            assert semantic.search('重复问题') == [email_id]
            assert semantic.search('重复问题') == [email_id]
            assert embed.call_count == 1
            with patch.dict(sys.modules, {'numpy': None}):
                assert semantic.search('重复问题') == [email_id], 'stdlib fallback changed ranking'
            with db.conn() as c:
                c.execute('UPDATE emails SET remote_missing=1 WHERE id=?', (email_id,))
            assert semantic.search('重复问题') == [], 'cached query revived deleted mail'
            with db.conn() as c:
                c.execute('UPDATE emails SET remote_missing=0 WHERE id=?', (email_id,))

        started, release = threading.Event(), threading.Event()
        def blocked(texts):
            started.set()
            assert release.wait(3)
            return [VECTOR for _ in texts]
        with patch.object(semantic, 'embed_texts', side_effect=blocked) as embed:
            begin = time.monotonic()
            assert semantic.search('慢模型') == []
            assert time.monotonic() - begin < 0.8
            assert started.is_set()
            with semantic._search_lock:
                job = semantic._search_job
            try:
                for i in range(30):
                    assert semantic.search(f'新的搜索 {i}') == []
                with use(account(root, 'b')):
                    db.init_db()
                    assert semantic.search('慢模型', timeout=0.01) == []
                assert embed.call_count == 1, 'requests created unbounded model jobs'
            finally:
                release.set()
                assert job['done'].wait(3)
        # Finishing after the initiating context ended still belongs to A.
        assert job['result'] == [email_id]
        with use(account(root, 'b')):
            bid = seed()
            with patch.object(semantic, 'embed_texts', return_value=[VECTOR]) as embed:
                assert semantic.search('重复问题') == [bid]
                assert embed.call_count == 1, 'query cache crossed accounts'

        # Direct summary updates also invalidate vectors, not just mail imports.
        db.update_llm(email_id, summary='改为下周交付')
        with db.conn() as c:
            assert c.execute('SELECT count(*) FROM email_vectors').fetchone()[0] == 0
        def changed_while_embedding(texts):
            db.update_llm(email_id, summary='再次变更为月底')
            return [VECTOR for _ in texts]
        with patch.object(semantic, 'enabled', return_value=True), \
                patch.object(semantic, 'embed_texts', side_effect=changed_while_embedding):
            assert semantic.index_missing() == 0, 'wrote a vector for obsolete text'
        with patch.object(semantic, 'enabled', return_value=True), \
                patch.object(semantic, 'embed_texts', return_value=[VECTOR]):
            assert semantic.index_missing() == 1
        # A malformed vector cannot silently mark the index complete.
        with patch.object(semantic, 'embed_texts', return_value=[[float('nan')] * 512]):
            try:
                semantic.reindex()
            except ValueError:
                pass
            else:
                raise AssertionError('accepted NaN vectors')
        assert semantic.progress()['error'] and not semantic.progress()['running']
        with patch.object(semantic, 'enabled', return_value=False), \
                patch.object(semantic, 'embed_texts') as embed:
            assert semantic.index_missing() == 0
            semantic.reindex(background=True)
            embed.assert_not_called()
        with db.conn() as c:
            c.execute('UPDATE email_vectors SET embedding=? WHERE email_id=?', (b'bad', email_id))
        with patch.object(semantic, 'embed_texts', return_value=[VECTOR]):
            assert semantic.search('损坏记录') == []

        # Sync arriving during indexing requests one follow-up pass.
        started, release, completed = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def indexing():
            calls.append(config.DB_PATH)
            if len(calls) == 1:
                started.set()
                assert release.wait(3)
            else:
                completed.set()
            return 0
        with patch.object(semantic, 'enabled', return_value=True), \
                patch.object(semantic, 'index_missing', side_effect=indexing):
            semantic.schedule_missing()
            assert started.wait(2)
            semantic.schedule_missing()
            semantic.schedule_missing()
            release.set()
            assert completed.wait(2)
            # Wait for worker bookkeeping before removing the account database.
            deadline = time.monotonic() + 2
            while semantic.progress()['running'] and time.monotonic() < deadline:
                threading.Event().wait(.01)
        assert len(calls) == 2 and len(set(calls)) == 1
    print('Semantic resilience passed: bounded latency/work, cache isolation, updates, corruption, catch-up')


if __name__ == '__main__':
    main()
