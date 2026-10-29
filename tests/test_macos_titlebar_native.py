"""Actual Cocoa dispatch: double clicks work even when the drag view is covered."""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    if sys.platform != 'darwin':
        print('SKIP Cocoa titlebar dispatch requires macOS')
        return
    import AppKit as A
    from app import macos_appearance as chrome

    class MailAITitlebarTestWindow(A.NSWindow):
        pass

    class MailAITitlebarCoverView(A.NSView):
        def mouseDown_(self, event):
            pass

    app = A.NSApplication.sharedApplication()
    window = MailAITitlebarTestWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        ((100, 100), (1000, 700)), 15, A.NSBackingStoreBuffered, False)
    window.setReleasedWhenClosed_(False)
    try:
        chrome.install_unified_titlebar(window)
        chrome.apply_window_appearance(window, 'light')
        chrome.update_drag_region(window, 116, 240, 1000, [[108, 240], [650, 900]], [[720, 800]])
        host = window.contentView().superview()
        drag = window._mailai_drag_view
        # Reproduce a native titlebar/WebKit sibling receiving the event instead
        # of our overlay. Geometry is valid throughout this test.
        cover = MailAITitlebarCoverView.alloc().initWithFrame_(host.bounds())
        host.addSubview_positioned_relativeTo_(cover, A.NSWindowAbove, None)

        def event(x, top, clicks=2):
            view = window.contentView()
            bounds = view.bounds()
            local = A.NSMakePoint(bounds.origin.x + x, bounds.origin.y + bounds.size.height - top)
            location = view.convertPoint_toView_(local, None)
            return A.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
                A.NSEventTypeLeftMouseDown, location, 0, 1, window.windowNumber(), None, 1, clicks, 1)

        point = host.convertPoint_fromView_(event(180, 26).locationInWindow(), None)
        assert drag.hitTest_(point) == drag, 'Brand geometry is synchronized'
        assert host.hitTest_(point) == cover, 'The normal drag-view handler cannot receive this press'
        with patch.object(chrome, 'toggle_maximized') as maximize:
            app.sendEvent_(event(180, 26))
            maximize.assert_called_once_with(window)
            app.sendEvent_(event(680, 26))
            assert maximize.call_count == 2, 'Both brand and blank header space work'
            for x, top, clicks in [(400, 26, 2), (70, 26, 2), (750, 26, 2),
                                    (750, 2, 2), (180, 60, 2), (180, 26, 1)]:
                mouse = event(x, top, clicks)
                assert chrome.titlebar_mouse_event(window, mouse) == mouse
            assert maximize.call_count == 2, 'Search, controls, pet, content and single presses pass through'
            with patch.object(window, 'styleMask', return_value=A.NSWindowStyleMaskFullScreen):
                mouse = event(180, 26)
                assert chrome.titlebar_mouse_event(window, mouse) == mouse
            with patch.object(window, 'attachedSheet', return_value=object()):
                mouse = event(180, 26)
                assert chrome.titlebar_mouse_event(window, mouse) == mouse
            # Window points remain stable across non-primary display origins.
            window.setFrameOrigin_((-1400, 120))
            app.sendEvent_(event(180, 26))
            assert maximize.call_count == 3
            # A pending resize must not stretch old gaps over repositioned
            # buttons. Resume only after the actual web layout arrives.
            frame = window.frame()
            frame.size.width = 1400
            window.setFrame_display_(frame, False)
            mouse = event(950, 26)
            assert chrome.titlebar_mouse_event(window, mouse) == mouse
            assert maximize.call_count == 3
            chrome.update_drag_region(window, 116, 240, 1400, [[108, 240], [900, 1260]], [[1000, 1120]])
            app.sendEvent_(event(950, 26))
            assert maximize.call_count == 4
            mouse = event(1050, 26)
            assert chrome.titlebar_mouse_event(window, mouse) == mouse, 'Scaled pet exclusion remains live'
            other = A.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
                A.NSEventTypeLeftMouseDown, (180, 26), 0, 1, 0, None, 1, 2, 1)
            assert chrome.titlebar_mouse_event(window, other) == other
        assert window._mailai_titlebar_monitor is not None
    finally:
        window.close()
    assert window._mailai_titlebar_monitor is None, 'Closing the window removes its local monitor'
    print('PASS Cocoa dispatch: covered native titlebar, brand/gaps, controls/pet, fullscreen/sheets, external origin, resize and cleanup')


if __name__ == '__main__':
    main()
