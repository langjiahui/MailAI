"""Menu routing stays native, localized, and independent of live mailbox state."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.macos_menu import MacMenuBar, install_menu_factory
from app import ui_copy


class MenuTests(unittest.TestCase):
    def runtime(self):
        return SimpleNamespace(quitting=False, show_window=Mock(), _evaluate_js_safely=Mock())

    def test_hidden_window_is_restored_and_startup_clicks_are_retained(self):
        runtime = self.runtime()
        menu = MacMenuBar(runtime)
        menu.perform('settings');menu.perform('settings')
        runtime.show_window.assert_called()
        runtime._evaluate_js_safely.assert_not_called()
        menu.web_loaded()
        runtime._evaluate_js_safely.assert_called_once()
        self.assertIn('"settings"', runtime._evaluate_js_safely.call_args.args[1])
        menu.web_loaded()
        self.assertEqual(runtime._evaluate_js_safely.call_count, 1)
        menu.perform('updates')
        self.assertIn('"updates"', runtime._evaluate_js_safely.call_args.args[1])
        menu.web_loading()
        count = runtime._evaluate_js_safely.call_count
        menu.perform('help')
        self.assertEqual(runtime._evaluate_js_safely.call_count, count)
        menu.web_loaded()
        self.assertIn('"help"', runtime._evaluate_js_safely.call_args.args[1])
        count = runtime._evaluate_js_safely.call_count
        menu.perform('main-window')
        self.assertEqual(runtime._evaluate_js_safely.call_count, count)
        menu.perform('arbitrary-code');runtime.quitting = True;menu.perform('help')
        self.assertEqual(runtime._evaluate_js_safely.call_count, count)

    def test_menu_rebuild_hook_survives_window_switch(self):
        original = Mock(side_effect=lambda view, supplied: supplied)
        view_class = type('View', (), {'_recreate_menus':original})
        runtime = self.runtime()
        service = install_menu_factory(runtime, SimpleNamespace(BrowserView=view_class))
        with patch.object(service, 'populate', side_effect=lambda value: ('native', value)):
            self.assertEqual(view_class()._recreate_menus('main'), ('native', 'main'))
            self.assertEqual(view_class()._recreate_menus('compose'), ('native', 'compose'))
        self.assertIs(runtime._main_menu, service)

    @unittest.skipUnless(sys.platform == 'darwin', 'Requires Cocoa menu objects')
    def test_real_menu_objects_selectors_shortcuts_and_language(self):
        try:
            import AppKit as kit
        except ImportError:
            self.skipTest('Cocoa build dependency is not installed')
        service = MacMenuBar(self.runtime())
        root = kit.NSMenu.alloc().initWithTitle_('offline-menu-test')
        with patch.object(ui_copy, 'ui_language', return_value='zh-CN'):
            service.populate(root)
            self.assertEqual([item.title() for item in root.itemArray()], ['MailAI','编辑','显示','窗口','帮助'])
            application = root.itemAtIndex_(0).submenu()
            settings = next(item for item in application.itemArray() if item.title() == '设置…')
            self.assertEqual(settings.keyEquivalent(), ',')
            self.assertEqual(settings.keyEquivalentModifierMask(), kit.NSEventModifierFlagCommand)
            service.web_loaded()
            settings.target().performMailAIAction_(settings)
            self.assertIn('"settings"', service.runtime._evaluate_js_safely.call_args.args[1])
            quit_item = next(item for item in application.itemArray() if item.title() == '退出 MailAI')
            self.assertEqual(str(quit_item.action()), 'terminate:')
            self.assertIsNone(quit_item.target())
            editing = root.itemAtIndex_(1).submenu()
            copy = next(item for item in editing.itemArray() if item.title() == '复制')
            self.assertEqual(str(copy.action()), 'copy:')
            self.assertIsNone(copy.target(), 'Editing must use the focused native responder')
            fullscreen = next(item for item in root.itemAtIndex_(2).submenu().itemArray() if item.title() == '切换全屏')
            self.assertEqual(fullscreen.keyEquivalentModifierMask(), kit.NSEventModifierFlagCommand | kit.NSEventModifierFlagControl)
            self.assertIsNotNone(kit.NSApplication.sharedApplication().helpMenu())
            self.assertIsNotNone(kit.NSApplication.sharedApplication().windowsMenu())
        with patch.object(ui_copy, 'ui_language', return_value='en'):
            service.refresh_language()
            self.assertEqual([item.title() for item in root.itemArray()], ['MailAI','Edit','View','Window','Help'])
            self.assertEqual(settings.title(), 'Settings…')
            self.assertEqual(quit_item.title(), 'Quit MailAI')
        self.assertTrue(settings.target().validateMenuItem_(settings))
        service.runtime.quitting = True
        self.assertFalse(settings.target().validateMenuItem_(settings))


if __name__ == '__main__':
    unittest.main()
