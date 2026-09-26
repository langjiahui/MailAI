"""Windows notification click adapter for pystray 0.19's Win32 message loop.

NIN_BALLOONUSERCLICK is WM_USER + 5. A tray balloon has no stable per-message
payload, so clicks open the complete reminder inbox instead of guessing a task.
"""
NIN_BALLOONUSERCLICK = 0x405


def reminder_icon_class(base, on_click):
    class ReminderIcon(base):
        def _on_notify(self, wparam, lparam):
            if (lparam & 0xffff) == NIN_BALLOONUSERCLICK:
                on_click()
                return
            return super()._on_notify(wparam, lparam)
    return ReminderIcon
