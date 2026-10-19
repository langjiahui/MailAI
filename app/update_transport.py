"""HTTPS release transport: public IP pinning and validation on every redirect."""
import http.client
import urllib.error
import ipaddress
import ssl
from contextlib import contextmanager
from urllib.parse import urlparse, urljoin
import socket
import certifi

def _public_target(url):
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443)):
        raise ValueError('更新地址无效')
    addresses = sorted({item[4][0].split('%', 1)[0] for item in socket.getaddrinfo(
        parsed.hostname, 443, type=socket.SOCK_STREAM)})
    if not addresses or any(not ipaddress.ip_address(value).is_global for value in addresses):
        raise ValueError('更新地址指向本机、内网或保留地址')
    return parsed.hostname, addresses



@contextmanager
def open_public(url: str, *, headers=None, timeout=15, method='GET', body=None, allow_redirects=True):
    connection = None
    response = None
    try:
        for _ in range(6):
            parsed = urlparse(url)
            if parsed.scheme != 'https':
                raise ValueError('更新地址必须使用 HTTPS')
            hostname, addresses = _public_target(url)
            connection = http.client.HTTPSConnection(hostname, 443, timeout=timeout,
                context=ssl.create_default_context(cafile=certifi.where()))
            selected = addresses[0]
            connection._create_connection = lambda _address, connect_timeout, source_address=None: socket.create_connection(
                (selected, 443), connect_timeout, source_address)
            path = parsed.path or '/'
            if parsed.query:
                path += '?' + parsed.query
            connection.request(method, path, body=body, headers={
                'User-Agent': 'MailAI-Updater', 'Accept-Encoding': 'identity', **(headers or {})})
            response = connection.getresponse()
            if allow_redirects and method == 'GET' and response.status in {301, 302, 303, 307, 308}:
                location = response.getheader('Location')
                if not location:
                    raise ValueError('更新下载重定向无效')
                url = urljoin(url, location)
                response.close()
                connection.close()
                continue
            if response.status not in ({200, 206} if method == 'GET' else {200, 201, 204}):
                raise urllib.error.HTTPError('https://' + hostname, response.status, f'更新服务器返回 HTTP {response.status}', response.headers, None)
            yield response
            return
        raise ValueError('更新下载重定向过多')
    finally:
        if response:
            response.close()
        if connection:
            connection.close()
