"""Verified HTTPS updates, including system proxies and VPN synthetic DNS."""
import http.client
import urllib.error
import ipaddress
import ssl
from contextlib import contextmanager
from urllib.parse import urlparse, urljoin
import socket
import time
import certifi
from . import update_proxy

# Only these official GET endpoints may use proxy-side DNS or VPN Fake-IP.
# Unknown redirects and publisher uploads keep the strict public-IP boundary.
_OFFICIAL_HOSTS = frozenset({
    'github.com', 'api.github.com', 'objects.githubusercontent.com',
    'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com',
    'atomgit.com', 'raw.atomgit.com', 'file-cdn.gitcode.com',
})
_FAKE_IP_RANGE = ipaddress.ip_network('198.18.0.0/15')


class _NonPublicTarget(ValueError):
    def __init__(self, hostname, addresses):
        super().__init__('更新地址指向本机、内网或保留地址')
        self.hostname, self.addresses = hostname, addresses


def _parse_target(url):
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443) or any(char in url for char in '\r\n\t')):
        raise ValueError('更新地址无效')
    return parsed


def _public_target(url):
    parsed = _parse_target(url)
    addresses = sorted({item[4][0].split('%', 1)[0] for item in socket.getaddrinfo(
        parsed.hostname, 443, type=socket.SOCK_STREAM)})
    if not addresses or any(not ipaddress.ip_address(value).is_global for value in addresses):
        raise _NonPublicTarget(parsed.hostname, addresses)
    return parsed.hostname, addresses


def ssl_context():
    # Include Windows' trusted enterprise roots and the bundled public CAs.
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def _connection(url, method, timeout, connect_ip):
    parsed = _parse_target(url)
    official = method == 'GET' and parsed.hostname in _OFFICIAL_HOSTS and connect_ip is None
    proxy = update_proxy.proxy_for(url, timeout) if official else None
    context = ssl_context()
    if proxy:
        hostname, port, tunnel_headers = proxy
        # CONNECT sends the domain to the configured proxy, preserving origin
        # TLS/SNI without depending on the client's synthetic DNS answer.
        connection = http.client.HTTPSConnection(hostname, port, timeout=timeout, context=context)
        connection.set_tunnel(parsed.hostname, 443, headers=tunnel_headers)
        return connection
    try:
        hostname, addresses = _public_target(url)
    except _NonPublicTarget as exc:
        if (not official or not exc.addresses
                or any(not ipaddress.ip_address(value).is_global
                       and ipaddress.ip_address(value) not in _FAKE_IP_RANGE for value in exc.addresses)):
            raise
        hostname, addresses = exc.hostname, exc.addresses
        # TUN uses 198.18/15 as virtual destinations. This exception applies
        # only to exact official hosts, with TLS verification unchanged.
    if connect_ip:
        if not ipaddress.ip_address(connect_ip).is_global:
            raise ValueError('更新地址指向本机、内网或保留地址')
        addresses = [connect_ip]
    connection = http.client.HTTPSConnection(hostname, 443, timeout=timeout, context=context)

    def connect(_address, connect_timeout, source_address=None):
        # Pin DNS, trying another validated address if the first route fails.
        deadline = time.monotonic() + connect_timeout
        for index, selected in enumerate(addresses):
            try:
                remaining = max(.001, deadline - time.monotonic())
                return socket.create_connection((selected, 443), remaining, source_address)
            except OSError:
                if index + 1 == len(addresses) or time.monotonic() >= deadline:
                    raise

    connection._create_connection = connect
    return connection


def connection_diagnostic(error):
    """Summarize source failures without URLs, proxy passwords or CDN tokens."""
    for _ in range(8):
        if isinstance(error, update_proxy.ProxyConfigurationError):
            return str(error)
        if isinstance(error, ssl.SSLCertVerificationError):
            return '安全证书验证失败，请检查系统日期及公司受信任证书'
        if isinstance(error, urllib.error.HTTPError):
            return f'HTTP {error.code}'
        if isinstance(error, socket.gaierror):
            return '域名解析失败'
        if isinstance(error, TimeoutError):
            return '连接超时'
        if isinstance(error, _NonPublicTarget):
            return 'DNS 返回内网或保留地址，请检查 VPN 的 DNS 配置'
        cause = getattr(error, '__cause__', None) or getattr(error, 'reason', None)
        if not isinstance(cause, BaseException) or cause is error:
            break
        error = cause
    return '更新清单校验失败' if isinstance(error, ValueError) else '连接失败'


@contextmanager
def open_public(url: str, *, headers=None, timeout=15, method='GET', body=None, allow_redirects=True, connect_ip=None):
    connection = None
    response = None
    request_headers = {name: value for name, value in (headers or {}).items()
                       if name.lower() != 'proxy-authorization'}
    try:
        for _ in range(6):
            parsed = _parse_target(url)
            connection = _connection(url, method, timeout, connect_ip)
            if method == 'PUT':
                connection.blocksize = 256 * 1024
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
            try:
                connection.request(method, path, body=body, headers={
                    'User-Agent': 'MailAI-Updater', 'Accept-Encoding': 'identity', **request_headers})
            except OSError as exc:
                if str(exc).startswith('Tunnel connection failed: 407'):
                    raise update_proxy.ProxyConfigurationError('更新代理需要身份验证，请检查系统代理的登录或认证设置') from exc
                raise
            response = connection.getresponse()
            if allow_redirects and method == 'GET' and response.status in {301, 302, 303, 307, 308}:
                location = response.getheader('Location')
                if not location:
                    raise ValueError('更新下载重定向无效')
                next_url = urljoin(url, location)
                if urlparse(next_url).hostname != parsed.hostname:
                    request_headers = {name: value for name, value in request_headers.items()
                                       if name.lower() not in {'authorization', 'cookie', 'host'}}
                url = next_url
                response.close()
                connection.close()
                continue
            if response.status not in ({200, 206} if method == 'GET' else {200, 201, 204}):
                raise urllib.error.HTTPError('https://' + parsed.hostname, response.status, f'更新服务器返回 HTTP {response.status}', response.headers, None)
            yield response
            return
        raise ValueError('更新下载重定向过多')
    finally:
        if response:
            response.close()
        if connection:
            connection.close()
