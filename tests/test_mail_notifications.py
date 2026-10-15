"""Native mail preview, account-bound clicks and Windows fallback contracts."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import desktop, ui_preferences
from app.mail_notifications import notification_key, notification_target, notification_text
from app.windows_desktop import WindowsDesktopRuntime
from app.windows_notifications import WindowsToastService, toast_xml


def arrival(account='a', **mail):
    return dict(ok=True, received=1, fetched=1, account_id=account,
                account_user=account+'@example.test',
                mail=dict(id=7, subject='会议安排', from_name='张三', from_addr='a@example.test', **mail))


class MailNotificationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        preference = patch.object(ui_preferences, 'PREFERENCE_PATH', Path(folder.name)/'prefs.db')
        preference.start()
        self.addCleanup(preference.stop)

    def test_subject_sender_risk_language_and_muting(self):
        result = arrival()
        result['mail']['subject'] = '会议\r\n安排\u202e <b> {0}'
        result['quarantined'] = 1
        self.assertEqual(notification_text(result), ('会议 安排 <b> {0}', '张三\na@example.test · 其中 1 封需要安全关注'))
        ui_preferences.save('mailai-language', 'en')
        self.assertEqual(notification_text(result)[0], '会议 安排 <b> {0}')
        self.assertIn('Security attention needed: 1', notification_text(result)[1])
        result['mail']['subject'] = ''
        self.assertEqual(notification_text(result)[0], '(no subject)')
        for changed in ({'fetched':0}, {'canceled':True}, {'ok':False}, {'notifications_delivered':True}):
            self.assertIsNone(notification_text({**result, **changed}))

    def test_targets_do_not_alias_accounts_or_invent_summary_target(self):
        a, b = notification_target(arrival()), notification_target(arrival('b'))
        self.assertNotEqual(notification_key(a), notification_key(b))
        self.assertEqual(len(notification_key(a)), 32)
        for invalid in ({'account_id':''}, {'fetched':2}, {'mail':{'id':True}}, {'mail':[]}, {'mail':{'id':-1}}):
            self.assertIsNone(notification_target({**arrival(), **invalid}))

    def test_mac_mail_and_task_payloads_are_distinct(self):
        note = Mock()
        kit = SimpleNamespace(NSUserNotification=Mock(), NSUserNotificationCenter=Mock(),
                              NSUserNotificationDefaultSoundName='default')
        kit.NSUserNotification.alloc.return_value.init.return_value = note
        runtime = desktop.DesktopRuntime()
        target = notification_target(arrival())
        with patch.dict(sys.modules, AppKit=kit), patch.object(runtime, '_call_after_safely',
                side_effect=lambda _label, callback: (callback(), True)[1]):
            self.assertTrue(runtime._deliver_notification('邮件', '发件人', mail_target=target))
        self.assertIn('mailai_mail', note.setUserInfo_.call_args.args[0])
        self.assertTrue(note.setIdentifier_.call_args.args[0].startswith('mailai-mail:'))
        with patch.object(runtime, 'show_window') as show, patch.object(runtime, '_evaluate_js_safely') as script:
            runtime.open_mail_notification(target)
            show.assert_called_once()
            self.assertIn('mailaiOpenMailNotification', script.call_args.args[1])
            self.assertIn('"accountId": "a"', script.call_args.args[1])

    def test_windows_historical_clicks_keep_their_own_target(self):
        runtime = WindowsDesktopRuntime()
        runtime.tray, runtime.toast_service = Mock(), Mock()
        with patch.object(runtime, 'open_mail_notification') as opened:
            runtime.notify_poll_result(arrival('a'))
            first = runtime.toast_service.show.call_args.kwargs
            runtime.notify_poll_result(arrival('b'))
            second = runtime.toast_service.show.call_args.kwargs
            self.assertNotEqual(first['key'], second['key'])
            second['on_click']()
            first['on_click']()
            self.assertEqual([call.args[0]['accountId'] for call in opened.call_args_list], ['b', 'a'])
        runtime.tray.notify.assert_not_called()
        # A failed toast falls back once, even if the OS reports it repeatedly.
        first['on_failure']()
        first['on_failure']()
        runtime.tray.notify.assert_called_once()
        with patch.object(runtime, 'show_window') as show, patch.object(runtime, 'open_mail_notification') as opened:
            runtime.on_notification_click()
            show.assert_called_once()
            opened.assert_not_called()

    def test_windows_native_xml_and_winrt_callback_boundary(self):
        icon = Path(__file__).resolve().parents[1]/'app/web/static/assets/mailai-icon-256.png'
        root = ElementTree.fromstring(toast_xml('A & <B>', '发件人\n账号\x00', icon))
        self.assertEqual([node.text for node in root.findall('.//text')], ['A & <B>', '发件人', '账号'])
        self.assertEqual(root.find('.//image').attrib['placement'], 'appLogoOverride')
        self.assertNotIn('emailId', root.attrib)
        key = Mock(__enter__=Mock(return_value=Mock()), __exit__=Mock(return_value=False))
        registry = SimpleNamespace(CreateKey=Mock(return_value=key), HKEY_CURRENT_USER=1,
                                   SetValueEx=Mock(), REG_SZ=1)
        notification = Mock()
        manager = Mock()
        runtime = SimpleNamespace(init_apartment=Mock(), uninit_apartment=Mock(),
                                  ApartmentType=SimpleNamespace(MULTI_THREADED='mta'))
        modules = {'winreg':registry, 'winrt.runtime':runtime,
                   'winrt.windows.data.xml.dom':SimpleNamespace(XmlDocument=Mock()),
                   'winrt.windows.ui.notifications':SimpleNamespace(ToastNotification=Mock(return_value=notification),
                                                                    ToastNotificationManager=manager)}
        clicked, failed = Mock(), Mock()
        with patch.dict(sys.modules, modules):
            service = WindowsToastService(icon)
            service.show('主题', '发件人', key='one', group='mail', on_click=clicked, on_failure=failed)
        self.assertEqual(notification.tag, 'one')
        self.assertEqual(notification.group, 'mail')
        notification.add_activated.call_args.args[0](None, None)
        clicked.assert_called_once()
        notification.add_failed.call_args.args[0](None, None)
        failed.assert_called_once()
        manager.create_toast_notifier_with_id.return_value.show.assert_called_once_with(notification)
        runtime.init_apartment.assert_not_called()
        runtime.uninit_apartment.assert_not_called()

    def test_windows_failure_is_not_recorded_as_delivered(self):
        runtime = WindowsDesktopRuntime()
        runtime.tray = Mock()
        runtime.tray.notify.side_effect = RuntimeError('unavailable')
        with self.assertLogs('app.windows_desktop', level='ERROR'):
            self.assertFalse(runtime._notify_native('主题', '发件人'))

    @unittest.skipUnless(sys.platform == 'win32', 'Requires the actual Windows Runtime')
    def test_actual_windows_projection_without_sending_or_registration(self):
        from collections import OrderedDict
        from threading import RLock, Thread
        from winrt.windows.data.xml.dom import XmlDocument
        from winrt.windows.ui.notifications import ToastNotification
        # Exercise the real projection and production lifetime across a worker
        # exit, while replacing only OS delivery and avoiding registry writes.
        service = WindowsToastService.__new__(WindowsToastService)
        service._xml, service._toast = XmlDocument, ToastNotification
        service._manager = Mock()
        service._icon = Path(__file__).resolve().parents[1]/'app/web/static/assets/mailai-icon-256.png'
        service._lock, service._pending = RLock(), OrderedDict()
        failures = []
        def deliver():
            try:
                for number in range(3):
                    service.show('主题 & <literal>', '发件人\n账号',
                        key='projection-check-'+str(number), group='mail',
                        on_click=lambda: None, on_failure=lambda: None)
            except Exception as error:
                failures.append(error)
        worker = Thread(target=deliver)
        worker.start()
        worker.join(10)
        self.assertFalse(worker.is_alive(), 'Native projection worker completed')
        self.assertEqual(failures, [])
        self.assertEqual(service._manager.create_toast_notifier_with_id.return_value.show.call_count, 3)
        self.assertEqual([toast.tag for toast in service._pending.values()],
                         ['projection-check-'+str(number) for number in range(3)])
        for toast in service._pending.values():
            token = toast.add_activated(lambda _sender, _event: None)
            toast.remove_activated(token)
            self.assertEqual(toast.group, 'mail')



if __name__ == '__main__':
    unittest.main()
