"""Application menus owned by MailAI; Cocoa's responder chain owns editing."""
import json
import threading
from functools import lru_cache

from . import ui_copy
from .ui_copy import ui_text

WEB_ACTIONS = frozenset({'about', 'settings', 'updates', 'help', 'shortcuts', 'feedback',
                         'font-larger', 'font-smaller', 'font-reset'})


def menu_text(source):
    # The generic UI verb “显示” translates as “Show”; the macOS menu is “View”.
    if source == '显示' and ui_copy.ui_language() == 'en':
        return ui_text('显示菜单')
    return ui_text(source)


@lru_cache(maxsize=1)
def controller_class():
    import objc
    from AppKit import NSObject

    class MailAIMainMenuController(NSObject, protocols=[objc.protocolNamed('NSMenuItemValidation')]):
        @objc.IBAction
        def performMailAIAction_(self, sender):
            self.owner.perform(str(sender.representedObject()))

        def validateMenuItem_(self, item):
            return not self.owner.runtime.quitting

    return MailAIMainMenuController


class MacMenuBar:
    def __init__(self, runtime):
        self.runtime = runtime
        self.controller = None
        self.titles = []
        self.ready = False
        self.pending = []
        self.lock = threading.Lock()

    def populate(self, menu):
        import AppKit as kit
        if self.controller is None:
            self.controller = controller_class().alloc().init()
            self.controller.owner = self
        app = kit.NSApplication.sharedApplication()
        command, option, control, shift = (kit.NSEventModifierFlagCommand, kit.NSEventModifierFlagOption,
                                          kit.NSEventModifierFlagControl, kit.NSEventModifierFlagShift)
        menu.removeAllItems()
        self.titles = []

        def remember(node, source):
            node.setTitle_(menu_text(source))
            self.titles.append((node, source))
            return node

        def group(title):
            submenu = remember(kit.NSMenu.alloc().initWithTitle_(''), title)
            item = remember(kit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_('', None, ''), title)
            item.setSubmenu_(submenu)
            menu.addItem_(item)
            return submenu

        def item(parent, title, selector=None, key='', modifiers=None, action=None):
            node = remember(kit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                '', 'performMailAIAction:' if action else selector, key), title)
            node.setKeyEquivalentModifierMask_(command if modifiers is None else modifiers)
            if action:
                node.setTarget_(self.controller)
                node.setRepresentedObject_(action)
            parent.addItem_(node)
            return node

        def separator(parent):
            parent.addItem_(kit.NSMenuItem.separatorItem())

        application = group('MailAI')
        item(application, '关于 MailAI', action='about')
        item(application, '检查更新…', action='updates')
        separator(application)
        item(application, '设置…', key=',', action='settings')
        separator(application)
        services = kit.NSMenu.alloc().initWithTitle_('')
        item(application, '服务').setSubmenu_(services)
        app.setServicesMenu_(services)
        separator(application)
        item(application, '隐藏 MailAI', 'hide:', 'h')
        item(application, '隐藏其他', 'hideOtherApplications:', 'h', command | option)
        item(application, '全部显示', 'unhideAllApplications:')
        separator(application)
        # The AppDelegate handles terminate: through the existing draft-save flow.
        item(application, '退出 MailAI', 'terminate:', 'q')

        editing = group('编辑')
        item(editing, '撤销', 'undo:', 'z')
        item(editing, '重做', 'redo:', 'z', command | shift)
        separator(editing)
        for title, selector, key in [('剪切', 'cut:', 'x'), ('复制', 'copy:', 'c'),
                                     ('粘贴', 'paste:', 'v'), ('全选', 'selectAll:', 'a')]:
            item(editing, title, selector, key)

        view = group('显示')
        item(view, '放大界面', key='+', action='font-larger')
        item(view, '缩小界面', key='-', action='font-smaller')
        item(view, '标准字号', key='0', action='font-reset')
        separator(view)
        item(view, '布局与外观…', action='settings')
        item(view, '切换全屏', 'toggleFullScreen:', 'f', command | control)

        windows = group('窗口')
        item(windows, '最小化', 'performMiniaturize:', 'm')
        item(windows, '缩放窗口', 'performZoom:')
        separator(windows)
        item(windows, '显示主窗口', action='main-window')
        item(windows, '前置全部窗口', 'arrangeInFront:')
        app.setWindowsMenu_(windows)

        help_menu = group('帮助')
        item(help_menu, 'MailAI 使用帮助', key='?', action='help')
        item(help_menu, '快捷键说明', action='shortcuts')
        separator(help_menu)
        item(help_menu, '反馈问题…', action='feedback')
        app.setHelpMenu_(help_menu)
        return menu

    def refresh_language(self):
        for node, source in self.titles:
            node.setTitle_(menu_text(source))

    def perform(self, action):
        if self.runtime.quitting or action not in WEB_ACTIONS | {'main-window'}:
            return
        self.runtime.show_window()
        if action == 'main-window':
            return
        with self.lock:
            if not self.ready:
                # Coalesce repeated clicks during startup; retain their order.
                if action not in self.pending:
                    self.pending.append(action)
                return
        self._dispatch(action)

    def _dispatch(self, action):
        self.runtime._evaluate_js_safely('执行应用菜单',
            f'window.mailaiNativeMenu?.({json.dumps(action)})')

    def web_loaded(self):
        with self.lock:
            self.ready = True
            pending, self.pending = self.pending, []
        for action in pending:
            self._dispatch(action)

    def web_loading(self):
        with self.lock:
            self.ready = False


def install_menu_factory(runtime, cocoa):
    """Reapply our menu whenever pywebview creates or focuses a compose window."""
    service = MacMenuBar(runtime)
    runtime._main_menu = service
    original = cocoa.BrowserView._recreate_menus

    def recreate(view, user_menu):
        return service.populate(original(view, user_menu))

    cocoa.BrowserView._recreate_menus = recreate
    return service
