"""邮箱服务商自动发现回归测试。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.mail_providers import discover


def main():
    qq = discover("user@qq.com")
    assert qq["detected"] and qq["imap_host"] == "imap.qq.com"
    assert qq["smtp_host"] == "smtp.qq.com" and qq["smtp_port"] == 465

    outlook = discover("user@outlook.com")
    assert outlook["smtp_port"] == 587 and outlook["smtp_starttls"] is True
    assert outlook["smtp_ssl"] is False

    enterprise = discover("user@example-corp.test")
    assert enterprise["detected"] is False
    assert enterprise["imap_host"] == "imap.example-corp.test"
    assert enterprise["smtp_host"] == "smtp.example-corp.test"
    print("✅ 邮箱服务商自动识别测试通过")


if __name__ == "__main__":
    main()
