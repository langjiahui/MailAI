"""Read proxy settings without changing the user's network configuration."""
from __future__ import annotations

import base64
import sys
import urllib.request
from urllib.parse import unquote, urlsplit


class ProxyConfigurationError(OSError):
    """Actionable, credential-free proxy diagnostics safe to display."""


def _windows_pac(url: str, timeout: float) -> str | None:
    """Resolve configured PAC/WPAD with Windows, never on the UI thread.

    None means no auto configuration; an empty string is an explicit DIRECT.
    """
    import ctypes
    from ctypes import wintypes as wt

    class IEConfig(ctypes.Structure):
        _fields_ = [('auto', wt.BOOL), ('pac', ctypes.c_void_p),
                    ('proxy', ctypes.c_void_p), ('bypass', ctypes.c_void_p)]

    class Options(ctypes.Structure):
        _fields_ = [('flags', wt.DWORD), ('detect', wt.DWORD), ('pac', wt.LPCWSTR),
                    ('reserved', ctypes.c_void_p), ('reserved_flags', wt.DWORD),
                    ('auto_login', wt.BOOL)]

    class ProxyInfo(ctypes.Structure):
        _fields_ = [('access', wt.DWORD), ('proxy', ctypes.c_void_p),
                    ('bypass', ctypes.c_void_p)]

    winhttp = ctypes.WinDLL('winhttp', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GlobalFree.argtypes = [ctypes.c_void_p]
    kernel.GlobalFree.restype = ctypes.c_void_p
    winhttp.WinHttpGetIEProxyConfigForCurrentUser.argtypes = [ctypes.POINTER(IEConfig)]
    winhttp.WinHttpGetIEProxyConfigForCurrentUser.restype = wt.BOOL
    winhttp.WinHttpOpen.argtypes = [wt.LPCWSTR, wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD]
    winhttp.WinHttpOpen.restype = wt.HANDLE
    winhttp.WinHttpSetTimeouts.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_int, ctypes.c_int]
    winhttp.WinHttpSetTimeouts.restype = wt.BOOL
    winhttp.WinHttpGetProxyForUrl.argtypes = [wt.HANDLE, wt.LPCWSTR,
                                            ctypes.POINTER(Options), ctypes.POINTER(ProxyInfo)]
    winhttp.WinHttpGetProxyForUrl.restype = wt.BOOL
    winhttp.WinHttpCloseHandle.argtypes = [wt.HANDLE]
    winhttp.WinHttpCloseHandle.restype = wt.BOOL
    config, result = IEConfig(), ProxyInfo()
    session = None
    try:
        if not winhttp.WinHttpGetIEProxyConfigForCurrentUser(ctypes.byref(config)):
            return None
        if not config.auto and not config.pac:
            return None
        pac = ctypes.wstring_at(config.pac) if config.pac else None
        session = winhttp.WinHttpOpen('MailAI-Updater', 1, None, None, 0)  # NO_PROXY
        if not session:
            raise ProxyConfigurationError('无法读取 Windows 自动代理配置')
        millis = max(100, min(8000, int(timeout * 1000)))
        winhttp.WinHttpSetTimeouts(session, millis, millis, millis, millis)
        # WPAD is used only when enabled in the user's existing settings.
        options = Options(2 if pac else 1, 0 if pac else 3, pac, None, 0, False)
        if not winhttp.WinHttpGetProxyForUrl(session, url, ctypes.byref(options), ctypes.byref(result)):
            if not pac:
                # Automatic detection is often enabled on networks without
                # WPAD. Its absence must not break static proxy/direct access.
                return None
            raise ProxyConfigurationError(f'Windows 自动代理解析失败（错误 {ctypes.get_last_error()}），请检查代理或 PAC 配置')
        return ctypes.wstring_at(result.proxy) if result.proxy else ''
    finally:
        if session:
            winhttp.WinHttpCloseHandle(session)
        for pointer in (config.pac, config.proxy, config.bypass, result.proxy, result.bypass):
            if pointer:
                kernel.GlobalFree(pointer)


def _https_proxy(value: str) -> str:
    # WinHTTP returns a static proxy list, not the PAC JavaScript source.
    choices = value.split(';')
    for item in choices:
        name, separator, address = item.strip().partition('=')
        if separator and name.lower() == 'https':
            return address.strip()
    return next((item.strip() for item in choices if item.strip() and '=' not in item), '')


def proxy_for(url: str, timeout: float):
    """Return (host, port, CONNECT headers); never log proxy credentials."""
    hostname = urlsplit(url).hostname
    if urllib.request.proxy_bypass(hostname):
        return None
    environment = urllib.request.getproxies_environment()
    if 'https' in environment or 'all' in environment:
        value = environment.get('https') or environment.get('all') or ''
    else:
        value = _windows_pac(url, timeout) if sys.platform == 'win32' else None
        if value is None:
            # getproxies() ignores the registry even when the environment only
            # contains NO_PROXY. Read the Windows registry explicitly here.
            registry = getattr(urllib.request, 'getproxies_registry', None)
            proxies = registry() if sys.platform == 'win32' and registry else urllib.request.getproxies()
            value = proxies.get('https') or proxies.get('all') or ''
        else:
            value = _https_proxy(value)
    if not value:
        return None
    try:
        parsed = urlsplit(value if '://' in value else 'http://' + value)
    except ValueError:
        raise ProxyConfigurationError('更新代理配置无效，请检查系统代理设置') from None
    if parsed.scheme != 'http':
        raise ProxyConfigurationError('更新连接需要 HTTP CONNECT 代理，请检查系统 HTTPS 代理端口')
    if (not parsed.hostname or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or any(character in value for character in '\r\n')):
        raise ProxyConfigurationError('更新代理配置无效，请检查系统代理设置')
    try:
        port = parsed.port if parsed.port is not None else 80
        if port < 1:
            raise ValueError('Invalid port')
    except ValueError:
        raise ProxyConfigurationError('更新代理端口无效，请检查系统代理设置') from None
    headers = {}
    if parsed.username is not None:
        credentials = unquote(parsed.username) + ':' + unquote(parsed.password or '')
        headers['Proxy-Authorization'] = 'Basic ' + base64.b64encode(credentials.encode()).decode('ascii')
    return parsed.hostname, port, headers
