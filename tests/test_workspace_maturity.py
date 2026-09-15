"""Behavioral regressions: mailbox isolation, accurate retrieval and recoverable work."""
import os
import sys
import json
import tempfile
import threading
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, mail_assistant, system_settings, outbox, pipeline
from app.account_context import use


def main():
    from app.llm import client
    class StreamResponse(list):
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read1(self, size): return self.pop(0) if self else b''
    chunk = b'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n'
    with patch.object(client, 'available', return_value=True), patch.object(client.urllib.request, 'urlopen', return_value=StreamResponse([chunk])):
        try:
            list(client.chat_completion_stream([], require_completion=True))
            raise AssertionError('Premature EOF must not be reported as a complete answer')
        except RuntimeError:
            pass
    with patch.object(client, 'available', return_value=True), patch.object(client.urllib.request, 'urlopen', return_value=StreamResponse([chunk,b'data: [DONE]\n'])):
        assert list(client.chat_completion_stream([], require_completion=True)) == ['partial answer']
    with tempfile.TemporaryDirectory() as root:
        accounts = {key: {'user': f'{key}@example.test', 'host': 'imap.example.test',
                         'db_path': os.path.join(root, key + '.db'), 'raw_dir': root}
                    for key in ('a', 'b')}
        original = config.DB_PATH
        barrier = threading.Barrier(2)
        errors = []
        def worker(key):
            try:
                with use({'ACCOUNT_ID': key, 'DB_PATH': accounts[key]['db_path'], 'IMAP_USER': accounts[key]['user']}):
                    db.init_db(); barrier.wait(timeout=5)
                    for n in range(1105):
                        db.upsert_email({'uid':n + 1, 'subject':key, 'body_text':'needle hidden body', 'date':datetime.now().isoformat(), 'status':'inbox'})
                    assert config.IMAP_USER == accounts[key]['user']
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=worker, args=(key,)) for key in accounts]
        for t in threads: t.start()
        # Thousands of small WAL commits are intentionally exercised here. They
        # can take longer than 30 seconds on a cold Windows CI runner; never
        # leave a live writer behind while TemporaryDirectory removes the DB.
        for t in threads: t.join(120)
        assert not errors, errors
        assert all(not t.is_alive() for t in threads)
        assert config.DB_PATH == original
        with patch.object(system_settings, '_load_registry', return_value={'accounts':accounts}):
            pages = [system_settings.list_unified_inbox(limit=1000, offset=offset) for offset in (0,1000,2000)]
            assert list(map(len, pages)) == [1000,1000,210]
            assert len({(row['_account_id'], row['id']) for page in pages for row in page}) == 2210
            assert len(system_settings.list_unified_inbox(q='needle', limit=1000)) == 1000
        with use({'ACCOUNT_ID':'a', 'DB_PATH':accounts['a']['db_path'], 'IMAP_USER':'a@example.test'}):
            assert len(db.search_emails(['needle'], 1000)) == 1000
            assert len(db.search_emails(['needle'], 1000, 1000)) == 105
            today = datetime.now().isoformat()
            yesterday = (datetime.now() - timedelta(days=5)).isoformat()
            db.upsert_email({'uid':2000, 'subject':'旧可疑', 'date':yesterday, 'score':40, 'verdict':'suspicious', 'priority':'低'})
            db.upsert_email({'uid':2001, 'subject':'当前高风险', 'date':today, 'score':80, 'verdict':'phishing', 'priority':'高'})
            rows = mail_assistant.retrieve('今天有哪些高风险邮件')
            assert [r['subject'] for r in rows] == ['当前高风险']
            assert all(r['priority'] == '高' for r in mail_assistant.retrieve('优先级高的邮件'))
            assert not mail_assistant.alerts()['new_items'], 'First visit establishes a quiet baseline'
            fresh = db.upsert_email({'uid':2002, 'subject':'新可疑', 'date':today, 'score':40, 'verdict':'suspicious', 'arrival_kind':'new'})
            alert = mail_assistant.alerts()
            assert alert['new_risk_count'] == 1 and alert['new_suspicious_count'] == 1
            mail_assistant.mark_risk_alerts_seen([fresh])
            assert not mail_assistant.alerts()['new_items']
            db.upsert_email({'uid':2003, 'subject':'历史补齐', 'date':today, 'score':40, 'verdict':'suspicious', 'arrival_kind':'history'})
            assert not mail_assistant.alerts()['new_items']
            db.upsert_email({'uid':2002, 'score':80, 'verdict':'phishing'})
            assert mail_assistant.alerts()['new_high_risk_count'] == 1
            fallback = mail_assistant._fallback_answer('为什么有风险', [db.get_email(fresh)])
            assert '高风险' in fallback and '未提供具体证据' in fallback
            assert '999999' not in mail_assistant.validated_citations('来源[email_id:999999]', rows)
            assert len(mail_assistant.retrieve(' '.join(f'第{i}封' for i in range(1,21)))) == 20
            revision = db.mailbox_revision()['revision']; db.set_mail_state(1, is_read=True)
            assert db.mailbox_revision()['revision'] != revision
            # Queue insertion is idempotent; cancellation prevents any SMTP call.
            payload = {'subject':'Safe fixture','id':1}
            outbox.enqueue('cancel', payload, delay=0); outbox.enqueue('cancel', payload, delay=0)
            outbox.cancel('cancel')
            sends = []
            outbox.process(lambda data: sends.append(data) or {'ok':True})
            assert not sends
            outbox.enqueue('sent', payload, delay=0)
            outbox.process(lambda data: sends.append(data) or {'ok':True})
            outbox.process(lambda data: sends.append(data) or {'ok':True})
            assert len(sends) == 1
            outbox.enqueue('uncertain', payload, delay=0)
            def uncertain(data): raise TimeoutError('SMTP receipt unavailable')
            outbox.process(uncertain)
            assert next(item for item in outbox.items() if item['token'] == 'uncertain')['status'] == 'unknown'
            outbox.process(lambda data: sends.append(data))
            assert len(sends) == 1, 'Uncertain outcome must never be retried automatically'
            assert outbox.draft_pending(1)
            try:
                outbox.enqueue('duplicate-draft', payload, delay=0)
                raise AssertionError('Unresolved sending must block resubmission of the same draft')
            except ValueError:
                pass
            outbox.resolve('uncertain', False)
            assert not outbox.draft_pending(1)
            outbox.enqueue('linked-outcome', payload, delay=0)
            def interrupted_send(data):
                db.create_sent_message({'subject':'linked'})
                raise TimeoutError('receipt lost')
            outbox.process(interrupted_send)
            assert db.list_sent_messages()[0]['status'] == 'unknown'
            outbox.resolve('linked-outcome', True)
            assert db.list_sent_messages()[0]['status'] == 'sent'
            from app import mail_undo
            class FakeMail:
                def __enter__(self): return self
                def __exit__(self,*args): pass
                def set_seen(self,*args): pass
            before = db.get_email(2); db.set_mail_state(2, is_read=True); after = db.get_email(2)
            token = mail_undo.record('read',[before],[after])
            with patch.object(mail_undo,'MailClient',FakeMail):
                assert mail_undo.restore(token)['ok']
            assert not db.get_email(2)['is_read']
            db.set_mail_state(2, is_read=True)
            token = mail_undo.record('read',[before],[after])
            with patch.object(mail_undo,'MailClient',side_effect=OSError('offline')):
                assert mail_undo.restore(token)['ok'], 'Read-state undo must also be local-first'
            with db.conn() as c:
                assert c.execute('SELECT used FROM undo_operations WHERE token=?',(token,)).fetchone()[0] == 1
            assert not db.get_email(2)['is_read']
        with use({'ACCOUNT_ID':'b', 'DB_PATH':accounts['b']['db_path'], 'IMAP_USER':'b@example.test'}):
            assert not outbox.items(), 'Account B must never see account A queued messages'
            assert not mail_assistant.retrieve('优先级高的邮件'), 'No low-priority fallback'
    print('Workspace account isolation, 2210-row pagination, exact AI filters, alert lifecycle, outbox and undo passed')


if __name__ == '__main__': main()
