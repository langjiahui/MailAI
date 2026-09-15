"""常见邮箱服务商自动发现；未知域名回退为标准 IMAP/SMTP 主机名。"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class MailServerProfile:
    provider: str
    imap_host: str
    imap_port: int = 993
    imap_ssl: bool = True
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_ssl: bool = True
    smtp_starttls: bool = False


_PROVIDERS = {
    "qq.com": MailServerProfile("QQ 邮箱", "imap.qq.com", smtp_host="smtp.qq.com"),
    "foxmail.com": MailServerProfile("Foxmail 邮箱", "imap.qq.com", smtp_host="smtp.qq.com"),
    "163.com": MailServerProfile("网易 163 邮箱", "imap.163.com", smtp_host="smtp.163.com"),
    "126.com": MailServerProfile("网易 126 邮箱", "imap.126.com", smtp_host="smtp.126.com"),
    "yeah.net": MailServerProfile("网易 Yeah 邮箱", "imap.yeah.net", smtp_host="smtp.yeah.net"),
    "gmail.com": MailServerProfile("Gmail", "imap.gmail.com", smtp_host="smtp.gmail.com"),
    "googlemail.com": MailServerProfile("Gmail", "imap.gmail.com", smtp_host="smtp.gmail.com"),
    "outlook.com": MailServerProfile("Outlook", "outlook.office365.com", smtp_host="smtp.office365.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "hotmail.com": MailServerProfile("Outlook", "outlook.office365.com", smtp_host="smtp.office365.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "live.com": MailServerProfile("Outlook", "outlook.office365.com", smtp_host="smtp.office365.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "office365.com": MailServerProfile("Microsoft 365", "outlook.office365.com", smtp_host="smtp.office365.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "icloud.com": MailServerProfile("iCloud 邮箱", "imap.mail.me.com", smtp_host="smtp.mail.me.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "me.com": MailServerProfile("iCloud 邮箱", "imap.mail.me.com", smtp_host="smtp.mail.me.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "mac.com": MailServerProfile("iCloud 邮箱", "imap.mail.me.com", smtp_host="smtp.mail.me.com", smtp_port=587, smtp_ssl=False, smtp_starttls=True),
    "yahoo.com": MailServerProfile("Yahoo 邮箱", "imap.mail.yahoo.com", smtp_host="smtp.mail.yahoo.com"),
    "aliyun.com": MailServerProfile("阿里云邮箱", "imap.aliyun.com", smtp_host="smtp.aliyun.com"),
    "sina.com": MailServerProfile("新浪邮箱", "imap.sina.com", smtp_host="smtp.sina.com"),
    "sohu.com": MailServerProfile("搜狐邮箱", "imap.sohu.com", smtp_host="smtp.sohu.com"),
    "139.com": MailServerProfile("中国移动 139 邮箱", "imap.139.com", smtp_host="smtp.139.com"),
    "baosight.com": MailServerProfile("宝信企业邮箱", "imap.baosight.com", smtp_host="smtp.baosight.com"),
}


def discover(email: str) -> dict:
    address = (email or "").strip().lower()
    domain = address.rsplit("@", 1)[-1] if "@" in address else ""
    profile = _PROVIDERS.get(domain)
    detected = profile is not None
    if not profile:
        profile = MailServerProfile(
            "企业邮箱（自动推测）" if domain else "自定义邮箱",
            f"imap.{domain}" if domain else "",
            smtp_host=f"smtp.{domain}" if domain else "",
        )
    return {**asdict(profile), "domain": domain, "detected": detected}
