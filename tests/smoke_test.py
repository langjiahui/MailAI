"""冒烟测试：不连邮箱、不调 LLM，验证解析与规则引擎。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("IMAP_PASSWORD", "dummy")  # 避免配置告警干扰

from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

from app import db
from app.parser import parse_message, redact
from app.security import rules


def build_phishing() -> bytes:
    msg = MIMEMultipart()
    msg["From"] = "IT管理员 <it-support@baos1ght.com>"
    msg["Reply-To"] = "helpdesk@secure-verify.top"
    msg["To"] = "user@example.com"
    msg["Subject"] = "【紧急】您的邮箱密码将于今日过期，请立即验证"
    msg["Authentication-Results"] = "mx.example.com; spf=fail; dkim=fail; dmarc=fail header.from=baos1ght.com"
    msg["Message-ID"] = "<phish-001@test>"
    html = ('<html><body><p>尊敬的用户，您的邮箱密码已过期，账户将被冻结。</p>'
            '<p>请点击 <a href="http://192.168.99.5/login">https://mail.example.com</a> '
            '重新登录并输入密码。</p></body></html>')
    msg.attach(MIMEText(html, "html", "utf-8"))
    msg.attach(MIMEApplication(b"MZ fake", Name="密码重置工具.exe"))
    return msg.as_bytes()


def build_clean() -> bytes:
    msg = MIMEMultipart()
    msg["From"] = "张三 <zhangsan@example.com>"
    msg["To"] = "user@example.com"
    msg["Subject"] = "本周项目例会纪要"
    msg["Authentication-Results"] = "mx.example.com; spf=pass; dkim=pass; dmarc=pass header.from=example.com"
    msg["Message-ID"] = "<clean-001@test>"
    msg.attach(MIMEText("大家好，本周例会纪要见附件，请各组在周五前反馈进度。我的手机号13812345678", "plain", "utf-8"))
    return msg.as_bytes()


def main():
    db.init_db()

    phish = parse_message(900001, build_phishing(), save_raw=False)
    r1 = rules.scan(phish)
    print(f"[钓鱼样本] score={r1['score']} verdict={r1['verdict']}")
    for f in r1["findings"]:
        print(f"   - [{f['code']}] {f['detail']} (+{f['weight']})")
    assert r1["score"] >= 70, f"钓鱼样本应 >=70 分，实际 {r1['score']}"
    assert r1["verdict"] == "phishing"

    clean = parse_message(900002, build_clean(), save_raw=False)
    r2 = rules.scan(clean)
    print(f"[正常样本] score={r2['score']} verdict={r2['verdict']}")
    assert r2["verdict"] == "clean", f"正常内部邮件应为 clean，实际 {r2['verdict']} ({r2['score']}分)"

    # 内部模型默认保留原文；管理员仍可通过配置重新启用打码。
    from app import config
    sensitive = "联系我13812345678，身份证310110199001011234，卡号6222021234567890123"
    old_redaction = config.REDACT_BEFORE_LLM
    config.REDACT_BEFORE_LLM = False
    assert redact(sensitive) == sensitive
    config.REDACT_BEFORE_LLM = True
    masked = redact(sensitive)
    assert "13812345678" not in masked and "310110199001011234" not in masked
    config.REDACT_BEFORE_LLM = old_redaction
    print("[模型上下文] 内部模型默认保留邮件原文，可配置恢复打码")

    # 解析字段检查
    assert phish["from_addr"] == "it-support@baos1ght.com"
    assert any(u.startswith("http://192.168.99.5") for u in phish["urls"])
    assert phish["attachments"][0]["name"] == "密码重置工具.exe"
    print("[解析] 发件人/URL/附件提取正确")

    print("\n✅ 冒烟测试全部通过")


if __name__ == "__main__":
    main()
