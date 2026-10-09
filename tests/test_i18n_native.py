"""Native menus and notifications use saved language without translating data."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import desktop, ui_copy, ui_preferences, windows_desktop


class NativeCopyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.preference = patch.object(ui_preferences, 'PREFERENCE_PATH', Path(self.folder.name) / 'preferences.sqlite3')
        self.preference.start()
        self.addCleanup(self.preference.stop)
        self.addCleanup(self.folder.cleanup)

    def test_persisted_notification_language_and_account_data(self):
        result = {'ok': True, 'fetched': 2, 'quarantined': 1, 'errors': 3, 'account_user': '中文账号@example.test'}
        self.assertEqual(desktop.notification_text(result)[0], '收到 2 封新邮件')
        ui_preferences.save('mailai-language', 'en')
        self.assertEqual(desktop.notification_text(result),
                         ('2 new emails received', '中文账号@example.test · Security attention needed: 1; 3 emails will be retried on the next sync'))
        ui_preferences.save('mailai-language', None)
        self.assertEqual(desktop.notification_text(result)[0], '收到 2 封新邮件')

    def test_user_parameters_remain_literal(self):
        ui_preferences.save('mailai-language', 'en')
        name = '联系人 {0} <b>正文</b>'
        self.assertEqual(ui_copy.ui_format('删除“{0}”？联系人和邮件都会保留。', name),
                         'Delete “联系人 {0} <b>正文</b>”? Contacts and emails will remain.')

    def test_mac_menu_refresh_on_saved_language(self):
        runtime = desktop.DesktopRuntime()
        entry = MagicMock()
        runtime._native_menu_entries = [(entry, '打开 MailAI')]
        runtime._status_item = MagicMock()
        with patch.object(desktop, '_runtime', runtime), patch.object(runtime, '_call_after_safely', side_effect=lambda _label, callback: callback()):
            ui_preferences.save('mailai-language', 'en')
            entry.setTitle_.assert_called_with('Open MailAI')
            runtime._status_item.button().setToolTip_.assert_called_with('MailAI · Receiving mail in the background')
            ui_preferences.save('mailai-language', 'zh-CN')
            entry.setTitle_.assert_called_with('打开 MailAI')

    def test_windows_tray_refresh(self):
        class Menu(tuple):
            SEPARATOR = None
            def __new__(cls, *items):
                return super().__new__(cls, items)
        fake = SimpleNamespace(Menu=Menu, MenuItem=lambda text, _callback, **kwargs: text)
        runtime = windows_desktop.WindowsDesktopRuntime()
        runtime.tray = SimpleNamespace(title='', menu=None, update_menu=MagicMock())
        with patch.dict(sys.modules, {'pystray': fake}), patch.object(windows_desktop, '_runtime', runtime):
            ui_preferences.save('mailai-language', 'en')
            self.assertEqual(runtime.tray.menu, ('Open MailAI', 'Fetch mail now', 'Reminder history', None, 'Quit MailAI'))
            runtime.tray.update_menu.assert_called_once()
            ui_preferences.save('mailai-language', 'zh-CN')
            self.assertEqual(runtime.tray.menu[0], '打开 MailAI')


if __name__ == '__main__':
    unittest.main()
