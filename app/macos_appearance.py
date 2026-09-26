"""Native titlebar appearance, without replacing macOS window controls."""

_drag_view_class = None


def install_unified_titlebar(window):
    """Extend WebKit behind a native unified toolbar, retaining system controls."""
    from AppKit import (NSToolbar, NSView, NSWindowStyleMaskFullSizeContentView,
                        NSWindowStyleMaskFullScreen, NSWindowToolbarStyleUnified,
                        NSViewWidthSizable, NSViewMinYMargin, NSUserDefaults, NSWindowAbove,
                        NSNotificationCenter, NSWindowWillEnterFullScreenNotification,
                        NSWindowDidExitFullScreenNotification, NSWindowWillCloseNotification)
    global _drag_view_class
    if _drag_view_class is None:
        class MailAITitlebarDragView(NSView):
            def hitTest_(self, point):
                if self.window().styleMask() & NSWindowStyleMaskFullScreen:
                    return None
                local = self.convertPoint_fromView_(point, self.superview())
                bounds = self.bounds().size
                # The web layout reports the non-interactive brand rectangle.
                # Search, menus and native traffic lights receive their own events.
                if 0 <= local.y <= bounds.height and 0 <= local.x <= bounds.width:
                    left, right = getattr(self, 'brand_region', (0, 0))
                    if left <= local.x < right or (local.x > 104 and local.y >= bounds.height - 5):
                        return self
                return None

            def windowWillEnterFullScreen_(self, notification):
                # An empty unified NSToolbar otherwise paints over the entire
                # web header in macOS full screen, hiding all primary actions.
                notification.object().toolbar().setVisible_(False)

            def windowDidExitFullScreen_(self, notification):
                notification.object().toolbar().setVisible_(True)

            def windowWillClose_(self, notification):
                NSNotificationCenter.defaultCenter().removeObserver_(self)

            def mouseDown_(self, event):
                if event.clickCount() == 2:
                    action = NSUserDefaults.standardUserDefaults().stringForKey_('AppleActionOnDoubleClick')
                    if action == 'Minimize':
                        self.window().performMiniaturize_(None)
                    elif action != 'None':
                        self.window().performZoom_(None)
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
        (NSWindowDidExitFullScreenNotification, 'windowDidExitFullScreen:'),
        (NSWindowWillCloseNotification, 'windowWillClose:'),
    ):
        center.addObserver_selector_name_object_(drag, selector, name, window)


def update_drag_region(window, left, right, viewport_width):
    drag = getattr(window, '_mailai_drag_view', None)
    if drag is not None:
        scale = window.contentView().bounds().size.width / viewport_width
        drag.brand_region = (left * scale, right * scale)


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
