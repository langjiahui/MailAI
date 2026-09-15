"""URL 风险分析：IP 直连、短链、锚文本伪装、仿冒域名、本地黑名单。"""
import logging
import os
import re
from urllib.parse import urlparse

from .. import config
from . import domutil, policy

log = logging.getLogger(__name__)

_IP_HOST_RE = re.compile(r"^https?://\d+\.\d+\.\d+\.\d+")
_AT_IN_URL_RE = re.compile(r"^https?://[^/]*@")

SHORTENERS = {
    "t.cn", "bit.ly", "tinyurl.com", "goo.gl", "dwz.cn", "url.cn", "suo.im",
    "shorturl.at", "is.gd", "t.co", "u6v.cn",
}
SUSPICIOUS_TLDS = {
    "top", "xyz", "buzz", "club", "icu", "cam", "rest", "fit", "tk", "ml",
    "ga", "cf", "gq", "pw", "cc", "loan", "win", "bid", "stream", "download",
}


def _load_blocklist() -> set[str]:
    if not os.path.exists(config.URL_BLOCKLIST):
        return set()
    with open(config.URL_BLOCKLIST, encoding="utf-8") as f:
        return {
            line.strip().lower()
            for line in f
            if line.strip() and not line.startswith("#")
        }


def is_blocked(domain: str) -> bool:
    """域名是否命中本地黑名单。"""
    if not domain:
        return False
    d = domain.lower().strip()
    return d in _load_blocklist()


def analyze_url(url: str, body_html: str = "") -> list[dict]:
    """返回该 URL 的命中项列表 [{code, detail, weight}]。"""
    findings = []
    u = (url or "").strip()
    if not u:
        return findings
    parsed = urlparse(u)
    host = (parsed.netloc or "").split(":")[0].lower()
    domain = domutil.registrable(host)

    # Trusted business applications may legitimately use redirects and unusual
    # paths. Their host/IP is informational unless a hard blocklist says otherwise.
    if policy.is_trusted_domain(host) and not is_blocked(host) and not is_blocked(domain):
        return findings

    if _IP_HOST_RE.match(u):
        findings.append({"code": "URL_IP", "detail": f"链接直接使用 IP 地址: {host}", "weight": 15})
    if _AT_IN_URL_RE.match(u):
        findings.append({"code": "URL_AT", "detail": f"链接含 @ 伪装真实目的地: {u[:80]}", "weight": 15})
    if "xn--" in host:
        findings.append({"code": "URL_PUNYCODE", "detail": f"链接域名使用 punycode 编码: {host}", "weight": 15})
    if domain in SHORTENERS:
        findings.append({"code": "URL_SHORT", "detail": f"短链接隐藏真实地址: {domain}", "weight": 10})
    tld = domain.rsplit(".", 1)[-1] if "." in domain else ""
    if tld in SUSPICIOUS_TLDS:
        findings.append({"code": "URL_TLD", "detail": f"可疑顶级域名 .{tld}: {domain}", "weight": 8})

    # 锚文本伪装：显示文本像 A 域名，实际指向 B 域名
    if body_html:
        for m in re.finditer(
            r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', body_html, re.I | re.S
        ):
            href, text = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if href.strip().lower() != u.lower():
                continue
            text_url = re.search(r"https?://[^\s]+", text)
            text_host = urlparse(text_url.group(0)).netloc if text_url else (
                text if re.fullmatch(r"[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}.*", text) else ""
            )
            if text_host:
                td, hd = domutil.registrable(text_host), domutil.registrable(
                    urlparse(href).netloc)
                if td and hd and td != hd:
                    findings.append({
                        "code": "URL_ANCHOR",
                        "detail": f"显示为 {td}，实际跳转到 {hd}",
                        "weight": 20,
                    })

    blocklist = _load_blocklist()
    if domain and domain in blocklist:
        findings.append({"code": "URL_BLOCKLIST", "detail": f"域名命中本地黑名单: {domain}", "weight": 50})

    # 仿冒本企业域名
    company = domutil.registrable(config.COMPANY_DOMAIN)
    if company and domain and domain != company and not host.endswith("." + company):
        sim = domutil.similarity(domain, company)
        if sim >= 0.8:
            findings.append({
                "code": "URL_LOOKALIKE",
                "detail": f"链接域名 {domain} 仿冒公司域名 {company} (相似度 {sim:.2f})",
                "weight": 35,
            })
    return findings
