"""IMAP 适配器：封装现有邮件解析逻辑。"""
from .base import BaseInputAdapter, ensure_email_dict
from .. import parser


class ImapAdapter(BaseInputAdapter):
    source = "imap"

    def normalize(self, raw) -> dict:
        """raw: (uid, raw_bytes)"""
        uid, data = raw
        email = parser.parse_message(uid, data)
        return ensure_email_dict(email)

    def iter_messages(self):
        # 由 pipeline 直接使用 MailClient，这里仅作占位
        raise NotImplementedError("由 pipeline 直接调用 MailClient")
