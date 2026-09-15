"""同步续传与附件邮件的本地回归测试，不连接外部服务。"""
import base64
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, smtp_client


def main():
    old_db = config.DB_PATH
    old_values = {name: getattr(config, name) for name in (
        "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_USE_IMAP_CREDENTIALS",
        "IMAP_USER", "IMAP_PASSWORD",
    )}
    try:
        with tempfile.TemporaryDirectory() as root:
            config.DB_PATH = os.path.join(root, "mailai.db")
            db.init_db()
            db.save_sync_job("fetch_all", status="running", total=400, processed=123,
                             message="正在初始化")
            job = db.get_sync_job()
            assert job["status"] == "running" and job["processed"] == 123

            draft_id = db.save_draft({"subject": "附件草稿", "attachments": [{
                "filename": "说明.txt", "content_type": "text/plain", "size": 3,
                "data_base64": base64.b64encode(b"abc").decode(),
            }]})
            assert db.get_draft(draft_id)["attachments"][0]["filename"] == "说明.txt"

            config.SMTP_HOST = "smtp.example.com"
            config.SMTP_USE_IMAP_CREDENTIALS = True
            config.IMAP_USER, config.IMAP_PASSWORD = "user@example.com", "secret"
            msg, recipients = smtp_client.build_message({
                "to_addr": "receiver@example.com", "subject": "附件测试",
                "body_html": "<p>正文</p>", "attachments": [{
                    "filename": "说明.txt", "content_type": "text/plain",
                    "data_base64": base64.b64encode(b"abc").decode(),
                }],
            })
            assert recipients == ["receiver@example.com"]
            assert any(part.get_filename() == "说明.txt" for part in msg.walk())

            normalized, normalized_recipients = smtp_client.build_message({
                "to_addr": "receiver@example.com, ",
                "cc_addr": "receiver@example.com； second@example.com;",
                "bcc_addr": "third@example.com， ",
                "subject": "收件人规范化",
                "body_html": "<p>正文</p>",
            })
            assert normalized_recipients == ["receiver@example.com", "second@example.com", "third@example.com"]
            assert str(normalized["To"]) == "receiver@example.com"
            assert str(normalized["Cc"]) == "second@example.com"
            assert normalized["Bcc"] is None

            transport = smtp_client.normalize_recipient_fields({
                "to_addr": '龚晓 <gong@example.com>, "张三,研发部" <zhang@example.com>'
            })
            display = smtp_client.recipient_fields_for_display(transport)
            assert display["to_addr"] == '龚晓 <gong@example.com>, "张三,研发部" <zhang@example.com>'
            assert smtp_client.normalize_recipient_fields(display)["recipients"] == [
                "gong@example.com", "zhang@example.com"
            ]

            pixel = base64.b64encode(b"fake-png-payload").decode()
            inline, _ = smtp_client.build_message({
                "to_addr": "receiver@example.com", "subject": "正文图片",
                "body_html": f'<p>图片如下</p><img src="data:image/png;base64,{pixel}">',
            })
            html_part = next(part for part in inline.walk() if part.get_content_type() == "text/html")
            assert "cid:" in html_part.get_content()
            related = [part for part in inline.walk() if part.get_content_maintype() == "image"]
            assert len(related) == 1 and related[0]["Content-ID"]
    finally:
        config.DB_PATH = old_db
        for name, value in old_values.items():
            setattr(config, name, value)
    print("✅ 同步续传、附件草稿与 MIME 发信测试通过")


if __name__ == "__main__":
    main()
