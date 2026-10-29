"""Native titlebar appearance, without replacing macOS window controls."""
import logging

log = logging.getLogger(__name__)

_drag_view_class = None


def titlebar_mouse_event(window, event):
    """Handle a double click before Cocoa/WebKit choose an overlapping view.

    Use window-local points, never screen pixels: mixed Retina/external displays
    and a titlebar container above our drag view must not change the hit area.
    Returning None consumes the second press so it cannot toggle twice.
    """
    from AppKit import NSWindowStyleMaskFullScreen
    if (event.window() != window or event.clickCount() != 2
            or window.styleMask() & NSWindowStyleMaskFullScreen
            or window.attachedSheet() is not None):
        return event
    drag = getattr(window, '_mailai_drag_view', None)
    if drag is None:
        return event
    content = window.contentView()
    bounds = content.bounds()
    point = content.convertPoint_fromView_(event.locationInWindow(), None)
    x = point.x - bounds.origin.x
    y = point.y - bounds.origin.y
    top = y if content.isFlipped() else bounds.size.height - y
    if not (104 < x < bounds.size.width and 0 <= top < 52):
        return event
    # NSEvent/NSView already use logical points, independent of the display's
    # backingScaleFactor. During a resize, wait for fresh layout rather than
    # stretching old gaps across controls whose positions may have changed.
    reference = getattr(drag, 'region_width', bounds.size.width)
    if reference <= 0 or abs(reference - bounds.size.width) > 1:
        return event
    position = x
    if any(start <= position < end for start, end in getattr(drag, 'excluded_regions', [])):
        return event
    if top > 5 and not any(start <= position < end for start, end in getattr(drag, 'drag_regions', [])):
        return event
    toggle_maximized(window)
    return None


def install_unified_titlebar(window):
    """Extend WebKit behind a native unified toolbar, retaining system controls."""
    from AppKit import (NSToolbar, NSView, NSWindowStyleMaskFullSizeContentView,
                        NSWindowStyleMaskFullScreen, NSWindowToolbarStyleUnified,
                        NSViewWidthSizable, NSViewMinYMargin, NSWindowAbove,
                        NSNotificationCenter, NSWindowWillEnterFullScreenNotification,
                        NSWindowDidEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
                        NSWindowDidExitFullScreenNotification, NSWindowWillCloseNotification,
                        NSEvent, NSEventMaskLeftMouseDown)
    global _drag_view_class
    if _drag_view_class is None:
        class MailAITitlebarDragView(NSView):
            def hitTest_(self, point):
                if self.window().styleMask() & NSWindowStyleMaskFullScreen:
                    return None
                local = self.convertPoint_fromView_(point, self.superview())
                bounds = self.bounds().size
                # The web layout reports non-interactive header regions.
                # Search, menus and native traffic lights receive their own events.
                if 0 <= local.y <= bounds.height and 0 <= local.x <= bounds.width:
                    # Floating controls can overlap the titlebar, including its
                    # narrow top drag strip. Give WebKit their events first.
                    if any(start <= local.x < end for start, end in getattr(self, 'excluded_regions', [])):
                        return None
                    left, right = getattr(self, 'brand_region', (0, 0))
                    regions = getattr(self, 'drag_regions', [(left, right)])
                    if any(start <= local.x < end for start, end in regions) or (local.x > 104 and local.y >= bounds.height - 5):
                        return self
                return None

            def windowWillEnterFullScreen_(self, notification):
                # An empty unified NSToolbar otherwise paints over the entire
                # web header in macOS full screen, hiding all primary actions.
                notification.object().toolbar().setVisible_(False)
                sync_fullscreen_layout(notification.object(), True)

            def windowDidEnterFullScreen_(self, notification):
                sync_fullscreen_layout(notification.object(), True)

            def windowWillExitFullScreen_(self, notification):
                sync_fullscreen_layout(notification.object(), False)

            def windowDidExitFullScreen_(self, notification):
                notification.object().toolbar().setVisible_(True)
                sync_fullscreen_layout(notification.object(), False)

            def windowWillClose_(self, notification):
                window = notification.object()
                monitor = getattr(window, '_mailai_titlebar_monitor', None)
                if monitor is not None:
                    NSEvent.removeMonitor_(monitor)
                    window._mailai_titlebar_monitor = None
                NSNotificationCenter.defaultCenter().removeObserver_(self)

            def mouseDown_(self, event):
                if event.clickCount() == 2:
                    toggle_maximized(self.window())
                else:
                    self.window().performWindowDragWithEvent_(event)
        _drag_view_class = MailAITitlebarDragView

    frame = window.frame()
    window.setStyleMask_(window.styleMask() | NSWindowStyleMaskFullSizeContentView)
    toolbar = NSToolbar.alloc().initWithIdentifier_('MailAIUnifiedTitlebar')
    toolbar.setShowsBaselineSeparator_(False)
    toolbar.setAllowsUserCustomization_(False)
    window.setToolbar_(toolbar)
    window.setToolbarStyle_(NSWindowToolbarStyleUnified)
    window.setFrame_display_(frame, True)
    content = window.contentView()
    host = content.superview()
    size = host.bounds().size
    drag = _drag_view_class.alloc().initWithFrame_(((0, size.height - 52), (size.width, 52)))
    drag.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
    # Attach beside WebKit: pywebview overrides addSubview_ and flips its Y axis.
    host.addSubview_positioned_relativeTo_(drag, NSWindowAbove, content)
    window._mailai_drag_view = drag
    # macOS versions differ in how NSTitlebarContainerView and WKWebView are
    # ordered. Geometry alone cannot ensure mouseDown_ reaches our overlay.
    # Monitor only this application's left presses; controls/other windows pass
    # through, and no global input monitoring or accessibility access is used.
    def monitor(event):
        try:
            return titlebar_mouse_event(window, event)
        except Exception:
            log.exception('处理标题栏双击失败')
            return event
    window._mailai_titlebar_monitor = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
        NSEventMaskLeftMouseDown, monitor)
    center = NSNotificationCenter.defaultCenter()
    for name, selector in (
        (NSWindowWillEnterFullScreenNotification, 'windowWillEnterFullScreen:'),
        (NSWindowDidEnterFullScreenNotification, 'windowDidEnterFullScreen:'),
        (NSWindowWillExitFullScreenNotification, 'windowWillExitFullScreen:'),
        (NSWindowDidExitFullScreenNotification, 'windowDidExitFullScreen:'),
        (NSWindowWillCloseNotification, 'windowWillClose:'),
    ):
        center.addObserver_selector_name_object_(drag, selector, name, window)


def sync_fullscreen_layout(window, fullscreen=None):
    """Push native Space state to WebKit without blocking the Cocoa event loop."""
    # Before the first navigation Cocoa still owns a plain NSView placeholder.
    # The ready theme bridge repeats this sync once WKWebView is installed.
    evaluate = getattr(window.contentView(), 'evaluateJavaScript_completionHandler_', None)
    if not callable(evaluate):
        return
    if fullscreen is None:
        from AppKit import NSWindowStyleMaskFullScreen
        fullscreen = bool(window.styleMask() & NSWindowStyleMaskFullScreen)
    value = 'true' if fullscreen else 'false'
    evaluate(
        "window.dispatchEvent(new CustomEvent('mailai:native-fullscreen',"
        "{detail:{fullscreen:" + value + "}}));", None)


def toggle_maximized(window):
    """Fill the current display's usable area; a second double click restores it."""
    screen = window.screen()
    if screen is None:
        return
    frame, visible = window.frame(), screen.visibleFrame()
    coords = lambda rect: (rect.origin.x, rect.origin.y, rect.size.width, rect.size.height)
    filled = all(abs(a - b) < 2 for a, b in zip(coords(frame), coords(visible)))
    previous = getattr(window, '_mailai_unmaximized_frame', None)
    if filled and previous is not None:
        # Clamp when displays or Dock placement changed since maximizing.
        x, y, width, height = previous
        width, height = min(width, visible.size.width), min(height, visible.size.height)
        x = min(max(x, visible.origin.x), visible.origin.x + visible.size.width - width)
        y = min(max(y, visible.origin.y), visible.origin.y + visible.size.height - height)
        target = ((x, y), (width, height))
        window._mailai_unmaximized_frame = None
    elif filled:
        window.performZoom_(None)
        return
    else:
        window._mailai_unmaximized_frame = coords(frame)
        target = visible
    window.setFrame_display_animate_(target, True, True)


def update_drag_region(window, left, right, viewport_width, gaps=None, excluded=None):
    drag = getattr(window, '_mailai_drag_view', None)
    if drag is not None:
        scale = window.contentView().bounds().size.width / viewport_width
        drag.region_width = window.contentView().bounds().size.width
        drag.brand_region = (left * scale, right * scale)
        drag.drag_regions = [(start * scale, end * scale) for start, end in gaps] if gaps is not None else [drag.brand_region]
        drag.excluded_regions = [(start * scale, end * scale) for start, end in (excluded or [])]


def apply_window_appearance(window, theme, mode='system'):
    """Call on the Cocoa thread; retain native layout, drag and fullscreen behavior."""
    from AppKit import NSAppearance, NSColor, NSWindowTitleHidden, NSWindowAbove

    dark = theme == 'dark'
    # Inherit the system appearance so WKWebView can keep observing OS changes.
    # An explicit override is only appropriate for a manually chosen app theme.
    appearance = None if mode == 'system' else NSAppearance.appearanceNamed_(
        'NSAppearanceNameDarkAqua' if dark else 'NSAppearanceNameAqua')
    window.setAppearance_(appearance)
    window.setTitleVisibility_(NSWindowTitleHidden)
    window.setTitlebarAppearsTransparent_(True)
    # Match the top of the web canvas, including explicit app theme overrides.
    rgb = (32, 38, 35) if dark else (241, 244, 242)
    window.setBackgroundColor_(NSColor.colorWithSRGBRed_green_blue_alpha_(*(v / 255 for v in rgb), 1.0))
    # pywebview paints this container explicitly after creating NSWindow.
    # Remove that backing tint as well; transparency alone cannot override it.
    frame = window.contentView().superview()
    titlebar = frame.subviews().lastObject() if frame is not None else None
    if titlebar is not None and hasattr(titlebar, 'setBackgroundColor_'):
        titlebar.setBackgroundColor_(NSColor.clearColor())
    # Cocoa can reorder WebKit when first showing the window. Restore the
    # narrow drag hit target above it after the bridge reports its ready theme.
    drag = getattr(window, '_mailai_drag_view', None)
    if drag is not None and frame is not None:
        frame.addSubview_positioned_relativeTo_(drag, NSWindowAbove, window.contentView())
    if hasattr(window, 'setTitlebarSeparatorStyle_'):
        window.setTitlebarSeparatorStyle_(1)  # NSTitlebarSeparatorStyleNone

    sync_fullscreen_layout(window)
