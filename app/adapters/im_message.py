"""IM 消息适配器（企业微信/钉钉等）——架构预留示例。"""
import re
from .base import BaseInputAdapter, ensure_email_dict


_URL_RE = re.compile(r'https?://[^\s<>"\'\]\)）】]+', re.I)


class ImMessageAdapter(BaseInputAdapter):
    """将 IM 消息结构映射为标准 email dict，复用同一套检测 pipeline。"""
    source = "im"

    def __init__(self, channel: str = "wechat_work"):
        self.channel = channel  # wechat_work / dingtalk / lark / teams

    def normalize(self, raw: dict) -> dict:
        """
        raw 示例：
        {
          "msgid": "abc123",
          "sender": "用户A",
          "sender_id": "u123",
          "content": "大家点击这个链接填写信息 http://...",
          "attachments": [{"name": "xx.xlsx", "content_type": "", "payload": b"..."}],
          "group_name": "xx项目群",
          "create_time": 1720000000,
        }
        """
        content = raw.get("content") or ""
        urls = _URL_RE.findall(content)
        email = {
            "uid": 0,
            "message_id": raw.get("msgid", ""),
            "in_reply_to": "",
            "references_header": "",
            "thread_id": raw.get("group_name", ""),
            "subject": raw.get("group_name", "IM 消息") + " - " + content[:30],
            "from_addr": raw.get("sender_id", "") + f"@{self.channel}.im",
            "from_name": raw.get("sender", "未知用户"),
            "to_addr": "me",
            "date": "",
            "snippet": content[:200],
            "body_text": content,
            "body_html": "",
            "urls": urls,
            "attachments": raw.get("attachments", []),
            "headers": {"channel": self.channel, "group": raw.get("group_name", "")},
            "auth_raw": "",
            "reply_to": "",
            "return_path": "",
            "list_unsubscribe": "",
            "precedence": "",
            "raw_path": "",
        }
        return ensure_email_dict(email)

    def iter_messages(self):
        raise NotImplementedError("需接入对应 IM 机器人 SDK/Webhook")
