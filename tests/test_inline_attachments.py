import os
import tempfile
import unittest
import sys
from pathlib import Path
from email.message import EmailMessage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.parser import extract_attachment, parse_message


def _message_with_signature_and_attachment() -> bytes:
    msg = EmailMessage()
    msg["From"] = "sender@example.com"
    msg["To"] = "receiver@example.com"
    msg["Subject"] = "出差报告"
    msg.set_content("请查收附件。")
    msg.add_alternative(
        '<html><body><p>请查收附件。</p><img src="cid:signature-logo@example"></body></html>',
        subtype="html",
    )
    html_part = msg.get_payload()[-1]
    html_part.add_related(
        b"signature-image",
        maintype="image",
        subtype="jpeg",
        cid="<signature-logo@example>",
        filename="company-logo.jpg",
        disposition="inline",
    )
    # 复现部分客户端的签名图片：有 Content-ID 和文件名，却没有 disposition。
    signature_part = html_part.get_payload()[-1]
    del signature_part["Content-Disposition"]
    msg.add_attachment(
        b"real-report-content",
        maintype="application",
        subtype="octet-stream",
        filename="report.xlsx",
    )
    return msg.as_bytes()


class InlineAttachmentTests(unittest.TestCase):
    def test_cid_signature_image_is_not_listed_as_attachment(self):
        parsed = parse_message(1, _message_with_signature_and_attachment(), save_raw=False)
        self.assertEqual([item["name"] for item in parsed["attachments"]], ["report.xlsx"])

    def test_download_index_matches_filtered_attachment_list(self):
        handle, path = tempfile.mkstemp(suffix=".eml")
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(_message_with_signature_and_attachment())
            attachment = extract_attachment(path, 0)
            self.assertIsNotNone(attachment)
            self.assertEqual(attachment["name"], "report.xlsx")
            self.assertEqual(attachment["payload"], b"real-report-content")
            self.assertIsNone(extract_attachment(path, 1))
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def test_regular_image_attachment_remains_visible(self):
        msg = EmailMessage()
        msg["From"] = "sender@example.com"
        msg["To"] = "receiver@example.com"
        msg.set_content("照片见附件")
        msg.add_attachment(b"photo", maintype="image", subtype="png", filename="photo.png")
        parsed = parse_message(2, msg.as_bytes(), save_raw=False)
        self.assertEqual([item["name"] for item in parsed["attachments"]], ["photo.png"])


if __name__ == "__main__":
    unittest.main()
