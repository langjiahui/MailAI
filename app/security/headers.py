"""认证头解析（SPF/DKIM/DMARC 结果）与发件域 DNS 体检。"""
import logging
import re
from functools import lru_cache

from . import domutil

log = logging.getLogger(__name__)

_AUTH_RES_RE = re.compile(r"(spf|dkim|dmarc)=(pass|fail|softfail|none|neutral|temperror|permerror)", re.I)
_DOMAIN_RE = re.compile(r"header\.from=([^\s;]+)", re.I)


def parse_auth_results(auth_raw: str) -> dict:
    """从 Authentication-Results 头提取三项认证结果，返回 {'spf': 'pass'|...|'unknown', ...}"""
    result = {"spf": "unknown", "dkim": "unknown", "dmarc": "unknown"}
    for mech, res in _AUTH_RES_RE.findall(auth_raw or ""):
        result[mech.lower()] = res.lower()
    m = _DOMAIN_RE.search(auth_raw or "")
    if m:
        result["header_from_domain"] = m.group(1).lower()
    return result


@lru_cache(maxsize=512)
def dns_profile(domain: str) -> dict:
    """查发件域的 SPF/MX/DMARC 记录。网络失败时全部 unknown，不阻塞主流程。"""
    profile = {"spf": "unknown", "mx": "unknown", "dmarc": "unknown"}
    domain = domutil.registrable(domain)
    if not domain:
        return profile
    try:
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 3

        try:
            txt = resolver.resolve(domain, "TXT")
            profile["spf"] = "present" if any(
                "v=spf1" in b"".join(r.strings).decode("utf-8", "ignore").lower() for r in txt
            ) else "missing"
        except Exception:
            profile["spf"] = "missing"

        try:
            resolver.resolve(domain, "MX")
            profile["mx"] = "present"
        except Exception:
            profile["mx"] = "missing"

        try:
            txt = resolver.resolve(f"_dmarc.{domain}", "TXT")
            profile["dmarc"] = "present" if any(
                "v=dmarc1" in b"".join(r.strings).decode("utf-8", "ignore").lower() for r in txt
            ) else "missing"
        except Exception:
            profile["dmarc"] = "missing"
    except Exception as e:
        log.debug("DNS 查询失败 %s: %s", domain, e)
    return profile
