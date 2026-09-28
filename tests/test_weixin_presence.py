"""Offline/exit notices with simulated networking; never contact a real account."""
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import weixin_remote as wx


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(enabled=True, bot_id='bot', user_id='owner', base_url=wx.BASE_URL)
        self.message = dict(message_type=1, from_user_id='owner', message_id='fixture',
                            context_token='context', item_list=[dict(type=1, text_item=dict(text='状态'))])
        self.original = (wx._notice_context, wx._presence_announced, wx._last_recovery_notice)
        wx._notice_context = dict(bot_id='bot', user_id='owner', context_token='context', at=100)
        wx._presence_announced = False
        wx._last_recovery_notice = float('-inf')

    def tearDown(self):
        wx._notice_context, wx._presence_announced, wx._last_recovery_notice = self.original

    def test_first_reply_and_private_context(self):
        with patch('app.remote_media.deliver'), patch.object(wx.remote_control, 'delivered'), \
                patch.object(wx.remote_control, 'handle_message', return_value='状态结果'), \
                patch.object(wx.remote_control, 'delivered'), \
                patch.object(wx.remote_control, 'deliver_sync_feedback'), \
                patch.object(wx, '_request', return_value={}) as request:
            wx.process_message(self.saved, 'secret', self.message)
            self.assertIn('关机、休眠或断网', request.call_args.kwargs['body']['msg']['item_list'][0]['text_item']['text'])
            wx.process_message(self.saved, 'secret', self.message)
            self.assertEqual('状态结果', request.call_args.kwargs['body']['msg']['item_list'][0]['text_item']['text'])
            wx.process_message(self.saved, 'secret', {**self.message, 'from_user_id': 'stranger'})
            self.assertEqual(request.call_count, 2)
            self.assertEqual(wx._notice_context['user_id'], 'owner')

    def test_notices_expire_and_require_current_owner(self):
        with patch.object(wx.time, 'monotonic', return_value=101), \
                patch.object(wx.remote_control, 'settings', return_value=self.saved) as settings, \
                patch.object(wx, '_request', return_value={}) as request:
            self.assertTrue(wx._send_presence(self.saved, 'secret', '在线'))
            self.assertEqual(request.call_args.kwargs['connect_timeout'], 1)
            self.assertEqual(request.call_args.kwargs['read_timeout'], 1)
            settings.return_value = {**self.saved, 'enabled': False}
            self.assertFalse(wx._send_presence(self.saved, 'secret', '关闭'))
            settings.return_value = {**self.saved, 'user_id': 'new-owner'}
            self.assertFalse(wx._send_presence(self.saved, 'secret', '关闭'))
            self.assertEqual(request.call_count, 1)
        with patch.object(wx.time, 'monotonic', return_value=1901), patch.object(wx, '_request') as request:
            self.assertFalse(wx._send_presence(self.saved, 'secret', '过期'))
            request.assert_not_called()

    def test_failed_notice_does_not_retry(self):
        with patch.object(wx.time, 'monotonic', return_value=101), \
                patch.object(wx.remote_control, 'settings', return_value=self.saved), \
                patch.object(wx, '_request', side_effect=requests.ConnectionError()) as request:
            self.assertFalse(wx._send_presence(self.saved, 'secret', '离线'))
            self.assertEqual(request.call_count, 1)

    def test_recovery_once_and_short_outages_silent(self):
        for duration, notices in ((35, 1), (2, 0)):
            now = [100]
            class Stop:
                count = 0
                def is_set(self):
                    return self.count >= 3
                def wait(self, _):
                    self.count += 1
                    now[0] += duration
            wx._last_recovery_notice = float('-inf')
            with patch.object(wx.time, 'monotonic', side_effect=lambda: now[0]), \
                    patch.object(wx, '_cursor', return_value=''), \
                    patch.object(wx, '_request', side_effect=[requests.ConnectionError(), {}, {}]), \
                    patch.object(wx, '_send_presence', return_value=True) as notice:
                wx._listen(self.saved, 'secret', Stop())
                self.assertEqual(notice.call_count, notices)

    def test_normal_stop_only_notifies_when_requested(self):
        original = wx._thread, wx._stop, wx._generation
        class Worker:
            def is_alive(self): return True
            def join(self, timeout): pass
        wx._thread, wx._stop = Worker(), threading.Event()
        try:
            with patch.object(wx.remote_control, 'settings', return_value=self.saved), \
                    patch.object(wx.credential_store, 'load', return_value='secret'), \
                    patch.object(wx, '_send_presence', return_value=True) as notice:
                wx.stop(timeout=0)
                notice.assert_not_called()
                wx.stop(timeout=0, notify=True)
                self.assertEqual(notice.call_count, 1)
                self.assertIn('正在退出', notice.call_args.args[2])
        finally:
            wx._thread, wx._stop, wx._generation = original


if __name__ == '__main__':
    unittest.main()
