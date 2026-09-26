"""Offline native contract: UI thread, caption colors, window state and bridge validation."""
import ctypes
import sys
import types
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.windows_appearance import apply_caption_theme, on_ui_thread
from app.windows_desktop import WindowsDesktopRuntime, WindowsDesktopApi

class Native:
    IsDisposed = False
    InvokeRequired = True
    WindowState = 'normal'
    is_fullscreen = False
    Handle = types.SimpleNamespace(ToInt64=lambda:0x123456789)
    def Invoke(self, action):
        self.InvokeRequired = False
        try: action()
        finally: self.InvokeRequired = True
    def toggle_fullscreen(self):
        assert not self.InvokeRequired
        self.is_fullscreen = not self.is_fullscreen
        self.WindowState = 'maximized' if self.is_fullscreen else 'normal'

native=Native()
calls=[]
def setter(hwnd, attribute, pointer, size):
    assert hwnd.value==0x123456789, '64-bit window handles must not be truncated'
    calls.append((attribute,ctypes.cast(pointer,ctypes.POINTER(ctypes.c_uint)).contents.value))
    return 0
win32=types.SimpleNamespace(dwmapi=types.SimpleNamespace(DwmSetWindowAttribute=Mock(side_effect=setter)))
with patch.object(ctypes,'windll',win32,create=True):
    assert apply_caption_theme(native,'dark')
    assert calls==[(20,1),(35,24|(28<<8)|(26<<16)),(36,226|(233<<8)|(229<<16))]
    calls.clear()
    assert apply_caption_theme(native,'light')
    assert calls[0]==(20,0) and calls[1]==(35,0xFFFFFF)
    # Older Windows rejects newer attributes; native controls remain available.
    win32.dwmapi.DwmSetWindowAttribute.side_effect=None
    win32.dwmapi.DwmSetWindowAttribute.return_value=-1
    assert apply_caption_theme(native,'dark')
with patch.object(ctypes,'windll',types.SimpleNamespace(),create=True):
    assert not apply_caption_theme(native,'dark')

forms=types.SimpleNamespace(FormWindowState=types.SimpleNamespace(Normal='normal',Maximized='maximized'))
with patch.dict(sys.modules,{'System':types.SimpleNamespace(Action=lambda fn:fn),'System.Windows.Forms':forms}), patch('app.windows_appearance.apply_caption_theme',return_value=True) as appearance:
    runtime=WindowsDesktopRuntime()
    runtime.window=types.SimpleNamespace(native=native)
    api=WindowsDesktopApi(runtime)
    assert api.set_window_theme('bad')=={'ok':False}
    assert api.set_window_theme('dark','bad')=={'ok':False}
    assert api.set_window_theme('dark','dark')=={'ok':True}
    appearance.assert_called_with(native,'dark')
    assert api.toggle_window_maximized()['maximized']
    assert not api.toggle_window_maximized()['maximized']
    for previous in ('normal','maximized'):
        native.WindowState=previous
        assert api.toggle_window_fullscreen()['fullscreen']
        assert api.toggle_window_maximized()['fullscreen']
        assert not api.toggle_window_fullscreen()['fullscreen']
        assert native.WindowState==previous, 'F11 restores the exact prior maximize state'
    native.IsDisposed=True
    assert api.toggle_window_maximized()=={'ok':False}
    native.IsDisposed=False
    result=on_ui_thread(native,lambda:{'ok':not native.InvokeRequired})
    assert result=={'ok':True}
print('Windows caption colors, 64-bit handles, UI-thread dispatch, maximize/fullscreen restore and disposal passed')
