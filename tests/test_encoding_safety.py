"""GB2312 正文与历史乱码修复的本地回归测试。"""
import os
import sys
import tempfile
from email.mime.text import MIMEText
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, parser, pipeline


def gb2312_mail() -> bytes:
    body = ("大家好：\n1、IMC上线后，请尽快优化慢SQL和慢服务。\n"
            "共享文档：https://docs.qq.com/sheet/example\n谢谢！")
    message = MIMEText(body, "plain", "gb2312")
    message["From"] = "huangxiaoyun@example.com"
    message["To"] = "user@example.com"
    message["Subject"] = "IMC系统统计慢SQL和慢服务"
    message["Date"] = "Sat, 28 Aug 2026 11:51:00 +0800"
    message["Message-ID"] = "<encoding-test@example.com>"
    return message.as_bytes()


def main():
    raw = gb2312_mail()
    parsed = parser.parse_message(1, raw, save_raw=False)
    assert parsed["body_text"].startswith("大家好")
    assert "慢SQL和慢服务" in parsed["body_text"]
    assert not parsed["body_decode_warning"]
    corrupt = "Һã 1IMCߺÿϵͳͳƵSQLҪŻȷϵͳƽȣǹĵӣ鷳Ҿ촦"
    assert parser.looks_corrupted(corrupt)
    assert not parser.looks_corrupted("Привет, это обычное русское деловое письмо")
    assert not parser.looks_corrupted("مرحبًا، هذه رسالة عمل عربية عادية")

    with tempfile.TemporaryDirectory() as root:
        db_path = os.path.join(root, "mailai.db")
        raw_dir = os.path.join(root, "raw")
        os.makedirs(raw_dir)
        raw_path = os.path.join(raw_dir, "1.eml")
        Path(raw_path).write_bytes(raw)
        with patch.multiple(config, DB_PATH=db_path, RAW_DIR=raw_dir, INBOX_FOLDER="INBOX"):
            db.init_db()
            email_id = db.upsert_email({
                "uid": 1, "folder": "INBOX", "subject": parsed["subject"],
                "from_addr": parsed["from_addr"], "date": parsed["date"],
                "snippet": corrupt, "body_text": corrupt, "body_html": "",
                "urls": parsed["urls"], "attachments": [], "score": 50,
                "verdict": "phishing", "status": "inbox", "recommended_status": "quarantine",
                "summary": "", "llm_phishing": 1,
                "llm_reasons": ["正文包含严重乱码，疑似编码攻击"],
                "findings": [
                    {"code": "AUTH_NONE", "detail": "无认证信息", "weight": 5},
                    {"code": "URL_ANOMALY", "detail": "异常链接", "weight": 10},
                    {"code": "VISION_SOCIAL_ENGINEERING", "detail": "正文包含乱码和外部链接", "weight": 35},
                ],
                "raw_path": raw_path,
            })
            result = pipeline.repair_mojibake_bodies()
            assert result["updated"] == 1
            repaired = db.get_email(email_id)
            assert repaired["body_text"].startswith("大家好")
            assert repaired["score"] == 15 and repaired["verdict"] == "clean"
            assert repaired["recommended_status"] == "inbox"
            assert repaired["llm_phishing"] is None
            assert all(item["code"] != "VISION_SOCIAL_ENGINEERING" for item in repaired["findings"])
            assert pipeline.repair_mojibake_bodies()["skipped"] is True
    print("GB2312 decoding, mojibake guard and historical false-positive repair passed")


if __name__ == "__main__":
    main()
