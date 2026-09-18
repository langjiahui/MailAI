"""语料导出：内部地址/公司域脱敏、标签生成与过滤。"""
import email
import email.policy
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, db

_spec = importlib.util.spec_from_file_location(
    "export_corpus", ROOT / "scripts" / "export_corpus.py")
export_corpus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(export_corpus)


def _make_raw(sender, sender_name, to_addr, body, company_domain):
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = f"来自 {company_domain} 的通知"
    msg["From"] = f"{sender_name} <{sender}>"
    msg["To"] = to_addr
    msg.set_content(body)
    return msg.as_bytes()


def main():
    with tempfile.TemporaryDirectory() as root:
        db_path = os.path.join(root, "mail.db")
        raw_dir = os.path.join(root, "raw")
        out_dir = os.path.join(root, "out")
        os.makedirs(raw_dir)
        with patch.object(config, "DB_PATH", db_path), \
                patch.object(config, "IMAP_USER", "me@corp-example.com"), \
                patch.object(config, "COMPANY_DOMAIN", "corp-example.com"):
            db.init_db()
            raws = {}
            samples = [
                (1, "boss@corp-example.com", "王总", "me@corp-example.com",
                 "请审阅 corp-example.com 的季度报告。", "clean"),
                (2, "attacker@evil-example.net", "IT 安全中心", "me@corp-example.com",
                 "点击验证。", "phishing"),
                (3, "ghost@nowhere.test", "", "me@corp-example.com", "无文件", "clean"),
            ]
            for uid, sender, name, to, body, verdict in samples:
                raw = _make_raw(sender, name, to, body, "corp-example.com")
                path = os.path.join(raw_dir, f"{uid}.eml")
                with open(path, "wb") as f:
                    f.write(raw)
                raws[uid] = path
                with db.conn() as c:
                    c.execute(
                        "INSERT INTO emails(uid,folder,from_addr,subject,date,verdict,raw_path,"
                        "created_at,remote_missing) VALUES(?,?,?,?,?,?,?,?,0)",
                        (uid, "INBOX", sender, f"样本{uid}", "2026-09-01T10:00:00", verdict,
                         path if uid != 3 else os.path.join(raw_dir, "missing.eml"), "2026-09-01T10:00:00"),
                    )

            result = export_corpus.export(None, out_dir)
            assert result["exported"] == 2, result
            assert result["skipped"] and "raw 文件缺失" in result["skipped"][0]["reason"]
            assert result["labels"] == {"clean_00001.eml": "clean", "phishing_00002.eml": "phishing"}

            # 内部样本：发件人地址改写、显示名丢弃、正文公司域替换
            clean_msg = email.message_from_bytes(
                open(os.path.join(out_dir, "clean_00001.eml"), "rb").read(),
                policy=email.policy.default)
            assert "boss@corp-example.com" not in str(clean_msg["From"])
            assert "王总" not in str(clean_msg["From"])
            assert "user-" in str(clean_msg["From"]) and "@example.test" in str(clean_msg["From"])
            assert "corp-example.com" not in str(clean_msg["Subject"])
            body_text = clean_msg.get_body(("plain",)).get_content()
            assert "corp-example.com" not in body_text
            assert clean_msg["X-MailAI-Export"] == "desensitized"

            # 外部攻击者地址原样保留（检测特征）
            phish_msg = email.message_from_bytes(
                open(os.path.join(out_dir, "phishing_00002.eml"), "rb").read(),
                policy=email.policy.default)
            assert "attacker@evil-example.net" in str(phish_msg["From"])
            # 收件人（本账号）脱敏
            assert "me@corp-example.com" not in str(phish_msg["To"])

            # labels.json 落盘且可增量合并
            labels = json.load(open(os.path.join(out_dir, "labels.json"), encoding="utf-8"))
            assert labels == result["labels"]

            # verdict 过滤
            out2 = os.path.join(root, "out2")
            only = export_corpus.export(None, out2, verdict="phishing")
            assert only["labels"] == {"phishing_00002.eml": "phishing"}

    print("✅ 语料导出脱敏、标签、过滤与缺失跳过测试通过")


if __name__ == "__main__":
    main()
