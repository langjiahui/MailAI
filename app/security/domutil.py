"""域名工具：主域提取、同形字归一、相似度。"""
import difflib
import re
from functools import lru_cache

try:
    import tldextract
    # Never download the public suffix list during mail processing. The bundled
    # snapshot is deterministic and avoids a hidden startup/network stall.
    _TLD_EXTRACT = tldextract.TLDExtract(suffix_list_urls=())
except Exception:
    _TLD_EXTRACT = None

# 常见视觉混淆字符归一（ rn→m 之类的连写在 url 层处理）
_HOMOGLYPHS = str.maketrans({
    "0": "o", "1": "l", "3": "e", "5": "s", "7": "t", "8": "b",
    "@": "a", "$": "s", "!": "i", "|": "l",
})


def normalize(domain: str) -> str:
    d = (domain or "").lower().strip().strip(".")
    d = d.translate(_HOMOGLYPHS)
    d = d.replace("rn", "m").replace("vv", "w").replace("cl", "d")
    return d


@lru_cache(maxsize=2048)
def registrable(host: str) -> str:
    """提取可注册主域（example.com.cn）。tldextract 离线失败时退化为末两段。"""
    host = (host or "").lower().strip(".")
    if not host:
        return ""
    if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", host):
        return host
    try:
        ext = _TLD_EXTRACT(host) if _TLD_EXTRACT else None
        if ext is None:
            raise RuntimeError("tldextract unavailable")
        if ext.registered_domain:
            return ext.registered_domain
    except Exception:
        pass
    parts = host.split(".")
    # 常见二级后缀
    if len(parts) >= 3 and parts[-1] == "cn" and parts[-2] in ("com", "net", "org", "gov", "edu"):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalize(a), normalize(b)).ratio()
