"""Native chrome is theme-aware without changing system window geometry."""
import sys
import types
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.macos_appearance import apply_window_appearance, update_drag_region
from app.desktop import DesktopApi

kit = types.SimpleNamespace(NSAppearance=Mock(), NSColor=Mock(), NSWindowTitleHidden=1, NSWindowAbove=1, NSWindowStyleMaskFullScreen=16384)
with patch.dict(sys.modules, AppKit=kit):
    for theme, appearance, rgb in (
        ('light', 'NSAppearanceNameAqua', (238,240,239)),
        ('dark', 'NSAppearanceNameDarkAqua', (32,36,34)),
    ):
        native=Mock()
        native.styleMask.return_value = 15
        apply_window_appearance(native, theme, theme)
        kit.NSAppearance.appearanceNamed_.assert_called_with(appearance)
        kit.NSColor.colorWithSRGBRed_green_blue_alpha_.assert_called_with(*(v/255 for v in rgb),1.0)
        native.setTitleVisibility_.assert_called_with(1)
        native.setTitlebarAppearsTransparent_.assert_called_with(True)
        native.setStyleMask_.assert_not_called()
        native.setFrame_display_.assert_not_called()
        native.standardWindowButton_.assert_not_called()
        native.setTitlebarSeparatorStyle_.assert_called_with(1)
    for theme in ('light', 'dark'):
        native = Mock()
        native.styleMask.return_value = 15
        apply_window_appearance(native, theme, 'system')
        native.setAppearance_.assert_called_once_with(None)
runtime=Mock()
api=DesktopApi(runtime)
with patch('app.desktop.sys.platform','win32'):
    assert api.set_window_theme('dark') == {'ok':False}
    assert api.set_window_drag_region(110, 220, 1200) == {'ok':False}
    runtime._call_after_safely.assert_not_called()
with patch('app.desktop.sys.platform','darwin'):
    assert api.set_window_theme('arbitrary') == {'ok':False}
    assert api.set_window_theme('dark', 'arbitrary') == {'ok':False}
    runtime._call_after_safely.assert_not_called()
    runtime._call_after_safely.return_value=True
    with patch('app.macos_appearance.apply_window_appearance') as apply, patch('app.macos_appearance.install_unified_titlebar') as install:
        assert api.set_window_theme('dark') == {'ok':True}
        runtime._call_after_safely.call_args.args[1]()
        apply.assert_called_once_with(runtime.window.native,'dark','system')
        apply.reset_mock()
        assert api.set_window_theme('light', 'light') == {'ok':True}
        runtime._call_after_safely.call_args.args[1]()
        apply.assert_called_once_with(runtime.window.native, 'light', 'light')
        install.assert_called_once_with(runtime.window.native)
    for bounds in ((0, 0, 1200), (-1, 200, 1200), (100, 1300, 1200), (float('nan'), 200, 1200), ('100', 200, 1200)):
        assert api.set_window_drag_region(*bounds) == {'ok':False}
    with patch('app.macos_appearance.update_drag_region') as update:
        assert api.set_window_drag_region(110, 220, 1200) == {'ok':True}
        runtime._call_after_safely.call_args.args[1]()
        update.assert_called_once_with(runtime.window.native, 110, 220, 1200)
native = Mock()
native.contentView().bounds.return_value.size.width = 900
update_drag_region(native, 120, 240, 1200)
assert native._mailai_drag_view.brand_region == (90, 180)
print('macOS light/dark appearance, native geometry preservation and Windows isolation passed')

# Initial geometry is installed before showing the window, then reused by the bridge.
prepared_runtime = Mock()
prepared_api = DesktopApi(prepared_runtime)
prepared_runtime.window.native.effectiveAppearance().bestMatchFromAppearancesWithNames_.return_value = 'NSAppearanceNameDarkAqua'
with patch('app.macos_appearance.apply_window_appearance') as apply, patch('app.macos_appearance.install_unified_titlebar') as install:
    prepared_api._prepare_window()
    assert prepared_api._macos_chrome_ready
    install.assert_called_once_with(prepared_runtime.window.native)
    apply.assert_called_once_with(prepared_runtime.window.native, 'dark', 'system')
    with patch('app.desktop.sys.platform','darwin'):
        prepared_api.set_window_theme('light','light')
        prepared_runtime._call_after_safely.call_args.args[1]()
    install.assert_called_once()
    apply.assert_called_with(prepared_runtime.window.native, 'light', 'light')
print('Native geometry is ready before the first web frame and reused by the bridge')

# Verify native notifications, including the restoration path, without needing a display.
import app.macos_appearance as chrome
class FakeView:
    @classmethod
    def alloc(cls): return cls()
    def initWithFrame_(self, frame): return self
    def setAutoresizingMask_(self, mask): pass
kit.NSView = FakeView
kit.NSToolbar = Mock()
kit.NSWindowStyleMaskFullSizeContentView = 32768
kit.NSWindowStyleMaskFullScreen = 16384
kit.NSWindowToolbarStyleUnified = 3
kit.NSViewWidthSizable = 2
kit.NSViewMinYMargin = 8
kit.NSUserDefaults = Mock()
kit.NSNotificationCenter = Mock()
kit.NSWindowWillEnterFullScreenNotification = 'enter'
kit.NSWindowDidEnterFullScreenNotification = 'entered'
kit.NSWindowWillExitFullScreenNotification = 'exiting'
kit.NSWindowDidExitFullScreenNotification = 'exit'
kit.NSWindowWillCloseNotification = 'close'
native = Mock()
native.styleMask.return_value = 15
native.contentView().superview().bounds.return_value.size = types.SimpleNamespace(width=1200,height=800)
with patch.dict(sys.modules, AppKit=kit), patch.object(chrome, '_drag_view_class', None):
    chrome.install_unified_titlebar(native)
    drag = native._mailai_drag_view
    center = kit.NSNotificationCenter.defaultCenter()
    assert center.addObserver_selector_name_object_.call_count == 5
    event = Mock(); event.object.return_value = native
    drag.windowWillEnterFullScreen_(event)
    native.toolbar().setVisible_.assert_called_with(False)
    assert 'fullscreen:true' in native.contentView().evaluateJavaScript_completionHandler_.call_args.args[0]
    drag.windowDidExitFullScreen_(event)
    native.toolbar().setVisible_.assert_called_with(True)
    assert 'fullscreen:false' in native.contentView().evaluateJavaScript_completionHandler_.call_args.args[0]
    drag.windowWillClose_(event)
    center.removeObserver_.assert_called_once_with(drag)
print('Fullscreen toolbar occlusion, restoration and observer cleanup passed')

# Empty header regions are scaled like the brand; malformed bridge data is rejected.
with patch('app.desktop.sys.platform', 'darwin'):
    for gaps in ('bad', [[1]], [[200, 100]], [[0, 1300]], [[0, float('inf')]]):
        assert api.set_window_drag_region(110, 220, 1200, gaps) == {'ok': False}
    with patch('app.macos_appearance.update_drag_region') as update:
        assert api.set_window_drag_region(110, 220, 1200, [[110, 230], [700, 800]]) == {'ok': True}
        runtime._call_after_safely.call_args.args[1]()
        update.assert_called_once_with(runtime.window.native,110,220,1200,[[110,230],[700,800]])

def rect(x,y,w,h):
    return types.SimpleNamespace(origin=types.SimpleNamespace(x=x,y=y),size=types.SimpleNamespace(width=w,height=h))
class Window:
    def __init__(self):
        self.current=rect(100,80,1000,700)
        self.visible=rect(0,40,1512,900)
    def frame(self): return self.current
    def screen(self): return self
    def visibleFrame(self): return self.visible
    def setFrame_display_animate_(self,target,display,animate):
        self.current=rect(*target[0],*target[1]) if isinstance(target,tuple) else target
window=Window()
chrome.toggle_maximized(window)
assert window.frame().size.width==1512 and window.frame().origin.y==40
chrome.toggle_maximized(window)
assert window.frame().size.width==1000 and window.frame().origin.x==100 and window.frame().origin.y==80
chrome.toggle_maximized(window)
window.visible=rect(0,0,900,640)
window.current=window.visible
chrome.toggle_maximized(window)
assert window.frame().size.width==900 and window.frame().size.height==640
print('Double-click fills usable display, restores previous bounds and clamps after display changes')
