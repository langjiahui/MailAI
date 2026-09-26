"""Windows caption colors; keep the system frame, Snap and caption buttons."""
import ctypes
import logging

log = logging.getLogger(__name__)


def on_ui_thread(native, callback):
    """Bridge calls arrive on workers; WinForms properties belong to its UI thread."""
    if native is None or native.IsDisposed:
        return {"ok": False}
    result = []
    def run():
        if native.IsDisposed:
            result.append({"ok": False})
        else:
            result.append(callback())
    if native.InvokeRequired:
        from System import Action
        native.Invoke(Action(run))
    else:
        run()
    return result[0]


def apply_caption_theme(native, theme):
    """Unsupported DWM color attributes fall back to the OS caption (Windows 10)."""
    dark = theme == 'dark'
    rgb = lambda r, g, b: r | (g << 8) | (b << 16)
    caption = rgb(24, 28, 26) if dark else rgb(255, 255, 255)
    text = rgb(226, 233, 229) if dark else rgb(39, 57, 48)
    try:
        setter = ctypes.windll.dwmapi.DwmSetWindowAttribute
        setter.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
        setter.restype = ctypes.c_long
        hwnd = ctypes.c_void_p(native.Handle.ToInt64())
        # https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
        for attribute, value in ((20, int(dark)), (35, caption), (36, text)):
            color = ctypes.c_uint(value)
            setter(hwnd, attribute, ctypes.byref(color), ctypes.sizeof(color))
        return True
    except (AttributeError, OSError):
        log.debug('Windows caption theming is unavailable', exc_info=True)
        return False
