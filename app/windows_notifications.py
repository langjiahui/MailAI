"""Windows notification click adapter for pystray 0.19's Win32 message loop.

NIN_BALLOONUSERCLICK is WM_USER + 5. A tray balloon has no stable per-message
payload, so clicks open the complete reminder inbox instead of guessing a task.
"""
NIN_BALLOONUSERCLICK = 0x405

APP_ID = 'com.langjiahui.mailai'


def toast_xml(title, body, icon_path):
    """User headers are XML text, never markup or an activation command."""
    from xml.etree.ElementTree import Element, SubElement, tostring
    from .mail_notifications import clean_line
    root = Element('toast', {'launch': 'mailai', 'duration': 'short'})
    binding = SubElement(SubElement(root, 'visual'), 'binding', {'template': 'ToastGeneric'})
    SubElement(binding, 'image', {'placement': 'appLogoOverride',
                               'src': icon_path.resolve().as_uri(), 'alt': 'MailAI'})
    SubElement(binding, 'text').text = clean_line(title)
    for line in str(body).splitlines()[:2]:
        SubElement(binding, 'text').text = clean_line(line, 240)
    return tostring(root, encoding='unicode')


class WindowsToastService:
    """WinRT toasts with a distinct callback for every background notification.

    Handles are retained while toasts remain in Notification Center. Activation
    is supported while MailAI is running (including its background tray mode).
    """
    def __init__(self, icon_path):
        import winreg
        from collections import OrderedDict
        from threading import RLock
        from winrt.windows.data.xml.dom import XmlDocument
        from winrt.windows.ui.notifications import ToastNotification, ToastNotificationManager
        self._xml = XmlDocument
        self._toast = ToastNotification
        self._manager = ToastNotificationManager
        self._icon = icon_path
        self._lock = RLock()
        self._pending = OrderedDict()
        # Register only our per-user identity; no administrator permission.
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                              r'Software\Classes\AppUserModelId' + '\\' + APP_ID) as key:
            for name, value in [('DisplayName', 'MailAI'),
                                ('IconUri', str(icon_path.with_suffix('.ico').resolve())),
                                ('IconBackgroundColor', '0')]:
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)

    def show(self, title, body, *, key, group, on_click, on_failure):
        # PyWinRT initializes worker threads automatically. Keep the runtime
        # alive for retained toasts and callbacks; per-call teardown can release
        # their COM objects after the apartment has already been destroyed.
        document = self._xml()
        document.load_xml(toast_xml(title, body, self._icon))
        toast = self._toast(document)
        toast.tag = key
        toast.group = group
        toast.add_activated(lambda _sender, _event: on_click())
        toast.add_failed(lambda _sender, _event: on_failure())
        with self._lock:
            # Windows' per-app history is bounded; keep enough callbacks
            # for historical clicks, without retaining all mail forever.
            self._pending[key] = toast
            self._pending.move_to_end(key)
            while len(self._pending) > 128:
                self._pending.popitem(last=False)
        self._manager.create_toast_notifier_with_id(APP_ID).show(toast)


def reminder_icon_class(base, on_click):
    class ReminderIcon(base):
        def _on_notify(self, wparam, lparam):
            if (lparam & 0xffff) == NIN_BALLOONUSERCLICK:
                on_click()
                return
            return super()._on_notify(wparam, lparam)
    return ReminderIcon
