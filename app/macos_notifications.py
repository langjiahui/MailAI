"""Use one modern macOS notification client for mail and task reminders."""
import json
import logging
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from .mail_notifications import notification_key

log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def delegate_class():
    import objc
    import UserNotifications as un
    from Foundation import NSObject

    class MailAINotificationDelegate(NSObject, protocols=[objc.protocolNamed('UNUserNotificationCenterDelegate')]):
        def userNotificationCenter_willPresentNotification_withCompletionHandler_(self, center, notification, completion):
            completion(un.UNNotificationPresentationOptionBanner | un.UNNotificationPresentationOptionList |
                       un.UNNotificationPresentationOptionSound)

        def userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(self, center, response, completion):
            try:
                if response.actionIdentifier() != un.UNNotificationDefaultActionIdentifier:
                    return
                info = response.notification().request().content().userInfo() or {}
                self.runtime._call_after_safely('打开系统通知', lambda: self.runtime._open_notification_info(info))
            except Exception:
                log.exception('打开 macOS 通知失败')
            finally:
                completion()

    return MailAINotificationDelegate


class MacNotificationService:
    def __init__(self, runtime):
        import UserNotifications as un
        from Foundation import NSBundle
        bundle = NSBundle.mainBundle()
        # currentNotificationCenter aborts the process for a bare Python/CLI
        # executable. Only a registered .app can own native notifications.
        if not bundle.bundleIdentifier() or Path(str(bundle.bundlePath())).suffix != '.app':
            raise RuntimeError('Native notifications require an application bundle')
        self.un = un
        self.center = un.UNUserNotificationCenter.currentNotificationCenter()
        self.delegate = delegate_class().alloc().init()
        self.delegate.runtime = runtime  # UNUserNotificationCenter retains its delegate weakly.
        self.center.setDelegate_(self.delegate)

    def authorized(self, *, request=False, timeout=5):
        completed = threading.Event()
        accepted = []

        def settings_ready(settings):
            try:
                status = settings.authorizationStatus()
                if status == self.un.UNAuthorizationStatusNotDetermined and request:
                    options = self.un.UNAuthorizationOptionAlert | self.un.UNAuthorizationOptionSound | self.un.UNAuthorizationOptionBadge
                    self.center.requestAuthorizationWithOptions_completionHandler_(options, authorization_ready)
                    return
                accepted.append(status in (self.un.UNAuthorizationStatusAuthorized, self.un.UNAuthorizationStatusProvisional))
            except Exception:
                log.exception('读取 macOS 通知权限失败')
            completed.set()

        def authorization_ready(granted, error):
            if error is not None:
                log.warning('macOS 通知授权请求失败：%s', error)
            accepted.append(bool(granted) and error is None)
            completed.set()

        self.center.getNotificationSettingsWithCompletionHandler_(settings_ready)
        if not completed.wait(timeout):
            log.warning('读取 macOS 通知权限超时')
            return False
        return bool(accepted and accepted[0])

    def deliver(self, title, body, *, task_target=None, mail_target=None, timeout=5):
        if not self.authorized(timeout=timeout):
            log.warning('macOS 通知权限未就绪，系统通知未提交')
            return False
        content = self.un.UNMutableNotificationContent.alloc().init()
        content.setTitle_(title)
        content.setBody_(body)
        content.setSound_(self.un.UNNotificationSound.defaultSound())
        identifier = 'mailai-test:' + uuid.uuid4().hex
        if mail_target:
            content.setUserInfo_({'mailai_mail': json.dumps(mail_target)})
            identifier = 'mailai-mail:' + notification_key(mail_target)
        elif task_target:
            content.setUserInfo_({'mailai_task': json.dumps(task_target)})
            identifier = 'mailai-task:' + notification_key(task_target)
        request = self.un.UNNotificationRequest.requestWithIdentifier_content_trigger_(identifier, content, None)
        completed, accepted = threading.Event(), []

        def submitted(error):
            if error is not None:
                log.warning('macOS 系统拒绝通知请求：%s', error)
            accepted.append(error is None)
            completed.set()

        self.center.addNotificationRequest_withCompletionHandler_(request, submitted)
        if not completed.wait(timeout):
            log.warning('macOS 通知提交超时，将使用相同通知标识重试')
            return False
        return bool(accepted and accepted[0])
