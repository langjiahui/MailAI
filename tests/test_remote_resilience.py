"""Offline failure and concurrency checks for phone control."""
import json
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import remote_control, weixin_remote


class RemoteResilienceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='mailai-phone-resilience-')
        self.path_patch = patch.object(remote_control, 'PATH', Path(self.folder.name) / 'phone.sqlite3')
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.folder.cleanup()

    def test_weixin_replies_survive_restart_and_one_failure_does_not_pin_batch(self):
        saved = dict(bot_id='bot', user_id='owner', base_url=weixin_remote.BASE_URL)
        def message(number):
            return dict(message_type=1, from_user_id='owner', message_id=str(number),
                        context_token='private-context',
                        item_list=[dict(type=1, text_item=dict(text='状态'))])
        cursor, count = weixin_remote._queue_update_batch(saved, {
            'msgs': [message(1), message(2)], 'get_updates_buf': 'next-page'})
        self.assertEqual((cursor, count), ('next-page', 2))
        self.assertEqual(weixin_remote._cursor('bot'), 'next-page')
        with patch.object(weixin_remote, 'process_message', side_effect=[RuntimeError('first failed'), None]) as process:
            self.assertEqual(weixin_remote._drain_pending(saved, 'secret', threading.Event()), 1)
            self.assertEqual(process.call_count, 2)
        with closing(remote_control.connection()) as db:
            remaining = db.execute('SELECT payload FROM weixin_pending').fetchone()[0]
            self.assertEqual(json.loads(remaining)['message_id'], '1')
            self.assertNotIn('secret', remaining)
        # A new listener can resume the pending reply without rereading the batch.
        with closing(remote_control.connection()) as db, db:
            db.execute('UPDATE weixin_pending SET retry_at=0')
        with patch.object(weixin_remote, 'process_message') as process:
            self.assertEqual(weixin_remote._drain_pending(saved, 'secret', threading.Event()), 0)
            process.assert_called_once()

    def test_distinct_chats_run_together_but_config_changes_wait(self):
        saved = dict(enabled=True, client_id='app', corp_id='corp', staff_id='me', account_ids=[])
        entered = [threading.Event(), threading.Event()]
        release = threading.Event()
        writer_entered = threading.Event()
        failures = []

        def execute(key, state, config, command, channel):
            index = int(command)
            state['introduced'] = True
            entered[index].set()
            if not release.wait(2):
                raise TimeoutError('test worker did not release')
            return '完成'

        def command(index):
            try:
                remote_control.handle_message(corp_id='corp', staff_id='me',
                    conversation_id='chat-' + str(index), message_id=str(index), text=str(index))
            except Exception as exc:
                failures.append(exc)

        with patch.object(remote_control, 'settings', return_value=saved), \
                patch.object(remote_control, '_execute', side_effect=execute):
            workers = [threading.Thread(target=command, args=(i,)) for i in range(2)]
            for worker in workers:
                worker.start()
            try:
                self.assertTrue(all(event.wait(1) for event in entered), 'Chats must not share one execution lock')
                # Use a normal context so releasing the writer is deterministic.
                def change_config():
                    with remote_control.CONFIG_GATE.write():
                        writer_entered.set()
                writer = threading.Thread(target=change_config)
                writer.start()
                time.sleep(.05)
                self.assertFalse(writer_entered.is_set(), 'Access changes must wait for active commands')
            finally:
                release.set()
                for worker in workers:
                    worker.join(2)
                if 'writer' in locals() and writer.ident:
                    writer.join(2)
            self.assertTrue(writer_entered.is_set())
            self.assertFalse(failures)

    def test_old_weixin_binding_cannot_run_after_repairing(self):
        saved = dict(enabled=True, bot_id='new-bot', user_id='owner', account_ids=[])
        with patch.object(remote_control, 'settings', return_value=saved), \
                patch.object(remote_control, '_execute') as execute:
            response = remote_control.handle_message(channel='weixin', binding_id='old-bot',
                staff_id='owner', conversation_id='owner', message_id='old-message', text='最新邮件')
            self.assertIsNone(response)
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
