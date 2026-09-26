"""Native titlebar appearance, without replacing macOS window controls."""

_drag_view_class = None


def install_unified_titlebar(window):
    """Extend WebKit behind a native unified toolbar, retaining system controls."""
    from AppKit import (NSToolbar, NSView, NSWindowStyleMaskFullSizeContentView,
                        NSWindowStyleMaskFullScreen, NSWindowToolbarStyleUnified,
                        NSViewWidthSizable, NSViewMinYMargin, NSWindowAbove,
                        NSNotificationCenter, NSWindowWillEnterFullScreenNotification,
                        NSWindowDidEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
                        NSWindowDidExitFullScreenNotification, NSWindowWillCloseNotification)
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
    if fullscreen is None:
        from AppKit import NSWindowStyleMaskFullScreen
        fullscreen = bool(window.styleMask() & NSWindowStyleMaskFullScreen)
    value = 'true' if fullscreen else 'false'
    window.contentView().evaluateJavaScript_completionHandler_(
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


def update_drag_region(window, left, right, viewport_width, gaps=None):
    drag = getattr(window, '_mailai_drag_view', None)
    if drag is not None:
        scale = window.contentView().bounds().size.width / viewport_width
        drag.brand_region = (left * scale, right * scale)
        drag.drag_regions = [(start * scale, end * scale) for start, end in gaps] if gaps is not None else [drag.brand_region]


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
    rgb = (32, 36, 34) if dark else (238, 240, 239)
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
