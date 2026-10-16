"""Modern native notifications; never submit a real notification or authorization."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, desktop, mailbox_jobs
from app.account_context import use
from app.macos_notifications import MacNotificationService, delegate_class


class MacNotificationTests(unittest.TestCase):
    def test_bare_python_cannot_enter_the_native_center(self):
        un = SimpleNamespace(UNUserNotificationCenter=Mock())
        bundle = SimpleNamespace(bundleIdentifier=lambda:None, bundlePath=lambda:'/tmp/python/bin')
        foundation = SimpleNamespace(NSBundle=SimpleNamespace(mainBundle=lambda:bundle))
        with patch.dict(sys.modules, {'UserNotifications':un,'Foundation':foundation}), self.assertRaises(RuntimeError):
            MacNotificationService(Mock())
        un.UNUserNotificationCenter.currentNotificationCenter.assert_not_called()

    def service(self, status=2, error=None):
        un = SimpleNamespace(UNAuthorizationStatusNotDetermined=0, UNAuthorizationStatusDenied=1,
            UNAuthorizationStatusAuthorized=2, UNAuthorizationStatusProvisional=3,
            UNAuthorizationOptionAlert=1, UNAuthorizationOptionSound=2, UNAuthorizationOptionBadge=4,
            UNMutableNotificationContent=Mock(), UNNotificationSound=Mock(), UNNotificationRequest=Mock())
        center = Mock()
        center.getNotificationSettingsWithCompletionHandler_.side_effect = lambda callback: callback(SimpleNamespace(authorizationStatus=lambda:status))
        center.addNotificationRequest_withCompletionHandler_.side_effect = lambda request, callback: callback(error)
        service = MacNotificationService.__new__(MacNotificationService)
        service.un, service.center = un, center
        return service, un, center

    def test_modern_submission_has_content_and_stable_account_bound_identity(self):
        service, un, center = self.service()
        mail = {'accountId':'a','emailId':7}
        self.assertTrue(service.deliver('会议 {0}', '发件人', mail_target=mail))
        content = un.UNMutableNotificationContent.alloc.return_value.init.return_value
        content.setTitle_.assert_called_with('会议 {0}')
        content.setBody_.assert_called_with('发件人')
        self.assertEqual(json.loads(content.setUserInfo_.call_args.args[0]['mailai_mail']), mail)
        first = un.UNNotificationRequest.requestWithIdentifier_content_trigger_.call_args.args[0]
        self.assertTrue(first.startswith('mailai-mail:'))
        self.assertTrue(service.deliver('会议 {0}', '发件人', mail_target=mail))
        self.assertEqual(first, un.UNNotificationRequest.requestWithIdentifier_content_trigger_.call_args.args[0])
        service.deliver('另一个账号', '发件人', mail_target={'accountId':'b','emailId':7})
        self.assertNotEqual(first, un.UNNotificationRequest.requestWithIdentifier_content_trigger_.call_args.args[0])
        service.deliver('任务', '内容', task_target={'accountId':'a','todoId':7})
        self.assertIn('mailai_task', content.setUserInfo_.call_args.args[0])
        self.assertTrue(un.UNNotificationRequest.requestWithIdentifier_content_trigger_.call_args.args[0].startswith('mailai-task:'))
        center.requestAuthorizationWithOptions_completionHandler_.assert_not_called()

    def test_denial_failure_and_timeout_are_not_success(self):
        service, un, center = self.service(status=1)
        self.assertFalse(service.deliver('主题', '内容'))
        center.addNotificationRequest_withCompletionHandler_.assert_not_called()
        center.requestAuthorizationWithOptions_completionHandler_.assert_not_called()
        service, un, center = self.service(error='rejected')
        self.assertFalse(service.deliver('主题', '内容'))
        center.addNotificationRequest_withCompletionHandler_.side_effect = lambda request, callback: None
        self.assertFalse(service.deliver('主题', '内容', timeout=0))
        center.getNotificationSettingsWithCompletionHandler_.side_effect = lambda callback: None
        self.assertFalse(service.authorized(timeout=0))

    def test_only_explicit_enable_requests_initial_permission(self):
        service, un, center = self.service(status=0)
        self.assertFalse(service.authorized())
        center.requestAuthorizationWithOptions_completionHandler_.assert_not_called()
        center.requestAuthorizationWithOptions_completionHandler_.side_effect = lambda options, callback: callback(True, None)
        self.assertTrue(service.authorized(request=True))
        center.requestAuthorizationWithOptions_completionHandler_.assert_called_once()

    def test_test_button_reports_native_failure(self):
        runtime = desktop.DesktopRuntime()
        service = Mock()
        service.authorized.return_value = False
        with patch.object(runtime, '_notifications', return_value=service):
            self.assertFalse(runtime.test_notification()['ok'])
            service.deliver.assert_not_called()
            service.authorized.return_value = True
            service.deliver.return_value = False
            self.assertFalse(runtime.test_notification()['ok'])
            service.deliver.return_value = True
            self.assertTrue(runtime.test_notification()['ok'])

    @unittest.skipUnless(sys.platform == 'darwin', 'Requires the actual Objective-C bridge')
    def test_real_delegate_protocol_and_click_completion(self):
        try:
            import UserNotifications as un
        except ImportError:
            self.skipTest('UserNotifications build dependency is not installed')
        delegate = delegate_class().alloc().init()
        runtime = Mock()
        runtime._call_after_safely.side_effect = lambda label, callback: (callback(), True)[1]
        delegate.runtime = runtime
        response = Mock()
        response.actionIdentifier.return_value = un.UNNotificationDefaultActionIdentifier
        info = {'mailai_mail':json.dumps({'accountId':'a','emailId':7})}
        response.notification.return_value.request.return_value.content.return_value.userInfo.return_value = info
        completion = Mock()
        delegate.userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(None, response, completion)
        runtime._open_notification_info.assert_called_once_with(info)
        completion.assert_called_once()
        completion.reset_mock();runtime.reset_mock()
        response.actionIdentifier.return_value = 'com.apple.UNNotificationDismissActionIdentifier'
        delegate.userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(None, response, completion)
        runtime._call_after_safely.assert_not_called();completion.assert_called_once()
        options = Mock()
        delegate.userNotificationCenter_willPresentNotification_withCompletionHandler_(None, None, options)
        self.assertTrue(options.call_args.args[0] & un.UNNotificationPresentationOptionBanner)
        content = un.UNMutableNotificationContent.alloc().init()
        request = un.UNNotificationRequest.requestWithIdentifier_content_trigger_('offline-bridge-test', content, None)
        self.assertEqual(request.identifier(), 'offline-bridge-test')

    def test_delivery_claims_expire_and_stale_completions_cannot_ack_new_claim(self):
        with tempfile.TemporaryDirectory() as folder, use({'ACCOUNT_ID':'fixture','DB_PATH':str(Path(folder)/'mail.db')}):
            db.init_db()
            email_id = db.upsert_email({'uid':1,'arrival_kind':'new','processing_complete':1})
            token = db.claim_mail_notification(email_id, now=100)
            self.assertTrue(token)
            self.assertEqual(db.get_email(email_id)['notification_sent'], 0)
            self.assertIsNone(db.claim_mail_notification(email_id, now=101))
            self.assertEqual(db.pending_mail_notifications(now=159), [])
            self.assertEqual(db.pending_mail_notifications(now=160), [email_id])
            retry = db.claim_mail_notification(email_id, now=160)
            self.assertNotEqual(token, retry)
            db.finish_mail_notification(email_id, token, True, now=161)
            self.assertEqual(db.get_email(email_id)['notification_sent'], 0)
            db.finish_mail_notification(email_id, retry, False, now=161)
            self.assertEqual(db.pending_mail_notifications(now=220), [])
            self.assertEqual(db.pending_mail_notifications(now=221), [email_id])
            retry = db.claim_mail_notification(email_id, now=221)
            db.finish_mail_notification(email_id, retry, True, now=222)
            self.assertEqual(db.get_email(email_id)['notification_sent'], 1)
            self.assertEqual(db.pending_mail_notifications(now=1000), [])

    def test_failed_mail_delivery_retries_with_account_and_survives_reinitialization(self):
        with tempfile.TemporaryDirectory() as folder:
            account = {'db_path':str(Path(folder)/'mail.db'),'user':'a@example.test'}
            with use({'ACCOUNT_ID':'a','DB_PATH':account['db_path'],'IMAP_USER':account['user']}):
                db.init_db()
                email_id = db.upsert_email({'uid':1,'arrival_kind':'new','processing_complete':1})
                with patch.object(sys, 'frozen', True, create=True), patch.object(sys, 'platform', 'darwin'), patch('app.desktop.notify_poll_result', return_value=False) as notify:
                    mailbox_jobs.notify_new_message(email_id)
                    self.assertEqual(db.get_email(email_id)['notification_sent'], 0)
                    self.assertEqual(db.pending_mail_notifications(), [])
                    db.init_db()
                    with db.conn() as c:
                        c.execute('UPDATE emails SET notification_retry_at=1 WHERE id=?', (email_id,))
                    notify.return_value = True
                    mailbox_jobs.retry_mail_notifications('a', account)
                    self.assertEqual(db.get_email(email_id)['notification_sent'], 1)
                    self.assertEqual(notify.call_count, 2)
                    self.assertEqual(notify.call_args.args[0]['account_id'], 'a')
                    mailbox_jobs.retry_mail_notifications('a', account)
                    self.assertEqual(notify.call_count, 2)
                    # A delivery exception is persisted for retry, not acknowledged.
                    second = db.upsert_email({'uid':2,'arrival_kind':'new','processing_complete':1})
                    notify.side_effect = RuntimeError('native unavailable')
                    with self.assertRaises(RuntimeError):
                        mailbox_jobs.notify_new_message(second)
                    self.assertEqual(db.get_email(second)['notification_sent'], 0)
                    with db.conn() as c:
                        c.execute('UPDATE emails SET notification_retry_at=1,is_read=1 WHERE id=?', (second,))
                    notify.side_effect = None
                    notify.return_value = True
                    mailbox_jobs.retry_mail_notifications('a', account)
                    self.assertEqual(notify.call_args.args[0]['fetched'], 0, 'Read mail must not generate a late banner')
                    self.assertEqual(db.get_email(second)['notification_sent'], 1)

    def test_retry_deadlines_wake_native_worker_without_spinning_source_builds(self):
        import time
        from app.energy_scheduler import next_delay
        with tempfile.TemporaryDirectory() as folder:
            account = {'db_path':str(Path(folder)/'mail.db'),'user':'a@example.test'}
            with use({'ACCOUNT_ID':'a','DB_PATH':account['db_path']}):
                db.init_db()
                email_id = db.upsert_email({'uid':1,'arrival_kind':'new','processing_complete':1})
                db.claim_mail_notification(email_id, now=time.time()-40)
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, 'platform', 'darwin'):
                self.assertTrue(18 <= next_delay({'a':account}, 'reminders') <= 21)
            with patch.object(sys, 'frozen', False, create=True):
                self.assertEqual(next_delay({'a':account}, 'reminders'), 60)


if __name__ == '__main__':
    unittest.main()
