"""URL 攻击链跟踪：跟踪短链/可疑链接的重定向路径。"""
import socket
import ssl
import ipaddress
import http.client
from functools import lru_cache
from urllib.parse import urlparse, urljoin

from .. import config

_SHORTENERS = {
    "t.cn", "bit.ly", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "dlvr.it",
    "short.link", "rebrand.ly", "cutt.ly", "sina.lt", "url.cn", "mrw.so",
    "0x7.me", "soo.gd", "x.co", "is.gd", "v.gd", "rb.gy", "short.io",
}


def _is_shortener(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(s in host for s in _SHORTENERS)


def _resolve_ip(host: str) -> str:
    try:
        return socket.gethostbyname(host)
    except Exception:
        return ""


def _public_target(url: str) -> tuple[str, list[str]]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("链接协议或地址无效")
    expected_port = 443 if parsed.scheme == "https" else 80
    if parsed.port not in (None, expected_port):
        raise ValueError("链接使用了不允许自动扫描的端口")
    addresses = sorted({item[4][0].split("%", 1)[0] for item in socket.getaddrinfo(
        parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80),
        type=socket.SOCK_STREAM,
    )})
    if not addresses:
        raise ValueError("链接域名无法解析")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if not address.is_global:
            raise ValueError("链接指向本机、内网或保留地址")
    return parsed.hostname, addresses


def _head(url: str, context: ssl.SSLContext, timeout: int):
    """Connect to the exact address that passed validation, preserving TLS SNI."""
    parsed = urlparse(url)
    hostname, addresses = _public_target(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    kwargs = {"timeout": timeout}
    if parsed.scheme == "https":
        kwargs["context"] = context
    connection = cls(hostname, port, **kwargs)
    selected = addresses[0]
    connection._create_connection = lambda _address, connect_timeout, source_address=None: socket.create_connection(
        (selected, port), connect_timeout, source_address
    )
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    connection.request("HEAD", path, headers={
        "Host": hostname, "User-Agent": "MailAI-LinkScanner/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    response = connection.getresponse()
    try:
        return response.status, dict(response.getheaders()), selected
    finally:
        response.close()
        connection.close()


@lru_cache(maxsize=512)
def follow_redirects(url: str, max_hops: int = 5, timeout: int = 5) -> dict:
    """
    跟踪 URL 重定向链。
    返回 {
        "chain": [{"url": ..., "status": ..., "hop": ..., "location": ...}],
        "final_url": ..., "final_domain": ..., "final_ip": ..., "status": "ok"|"timeout"|"error"
    }
    """
    chain = []
    current = url
    ctx = ssl.create_default_context()
    if not config.LLM_VERIFY_SSL:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    status_name = "ok"
    for hop in range(max(1, min(max_hops, 10))):
        try:
            status, headers, _selected = _head(current, ctx, max(1, min(timeout, 15)))
            location = headers.get("Location", headers.get("location", ""))
            chain.append({"url": current, "status": status, "hop": hop, "location": location})

            if 300 <= status < 400 and location:
                current = urljoin(current, location)
                _public_target(current)
                status_name = "limit" if hop + 1 >= max_hops else "ok"
                continue
            break
        except Exception as e:
            chain.append({"url": current, "status": 0, "hop": hop, "error": str(e)})
            blocked = isinstance(e, ValueError)
            return {
                "chain": chain,
                "final_url": current,
                "final_domain": urlparse(current).hostname or "",
                "final_ip": "" if blocked else _resolve_ip(urlparse(current).hostname or ""),
                "status": "blocked" if blocked else "timeout" if "timeout" in str(e).lower() else "error",
            }

    final_domain = urlparse(current).hostname or ""
    return {
        "chain": chain,
        "final_url": current,
        "final_domain": final_domain,
        "final_ip": _resolve_ip(final_domain),
        "status": status_name,
    }


def analyze_url_chain(url: str, body_html: str = "") -> list:
    """对单个 URL 做链路跟踪并返回 findings。"""
    from . import domutil, policy, urls as urlmod

    result = follow_redirects(url)
    findings = []
    final = result["final_url"]
    final_domain = result["final_domain"]
    blocked_final = urlmod.is_blocked(final_domain)
    trusted_final = policy.is_trusted_domain(final_domain) and not blocked_final
    result["trusted_final"] = trusted_final

    if result["status"] != "ok" and not trusted_final:
        findings.append({
            "code": "URL_CHAIN_ERROR",
            "detail": f"链接 {url[:60]} 跟踪失败: {result['status']}",
            "weight": 8,
        })

    if len(result["chain"]) > 1 and not trusted_final:
        findings.append({
            "code": "URL_REDIRECT_CHAIN",
            "detail": f"链接经过 {len(result['chain'])} 次跳转，最终落地 {final_domain}",
            "weight": 10,
        })

    # 对最终落地域名做 lookalike / blocklist 检测
    company = domutil.registrable(config.COMPANY_DOMAIN)
    if final_domain and not trusted_final and domutil.similarity(domutil.registrable(final_domain), company) >= 0.8:
        findings.append({
            "code": "URL_FINAL_LOOKALIKE",
            "detail": f"跳转后落地域名 {final_domain} 仿冒公司域名",
            "weight": 35,
        })

    if blocked_final:
        findings.append({
            "code": "URL_FINAL_BLOCKLIST",
            "detail": f"跳转后落地域名 {final_domain} 命中黑名单",
            "weight": 50,
        })

    # 短链直接加分
    if _is_shortener(url) and not trusted_final:
        findings.append({
            "code": "URL_SHORT_EXPANDED",
            "detail": f"短链展开后落地 {final_domain}",
            "weight": 10,
        })

    return findings, result


def is_suspicious_for_chain(url: str) -> bool:
    """判断一个 URL 是否值得跟踪链路的启发式。"""
    if _is_shortener(url):
        return True
    host = urlparse(url).netloc.lower()
    # IP 直连
    if host.replace(".", "").isdigit():
        return True
    return False
