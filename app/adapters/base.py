"""输入适配器基类与标准邮件字典类型。"""
from typing import Protocol, runtime_checkable


class EmailDict(dict):
    """标准邮件字典，所有适配器输出必须符合此结构。"""
    pass


@runtime_checkable
class BaseInputAdapter(Protocol):
    """输入适配器协议。"""

    source: str  # 'imap' / 'wechat_work' / 'dingtalk' / etc.

    def normalize(self, raw) -> EmailDict:
        """将原始消息转换为标准 email dict。"""
        ...

    def iter_messages(self):
        """可选：迭代拉取一批消息。"""
        ...


def ensure_email_dict(d: dict) -> EmailDict:
    """确保 dict 包含标准字段的默认值。"""
    defaults = {
        "uid": 0,
        "message_id": "",
        "in_reply_to": "",
        "references_header": "",
        "thread_id": "",
        "subject": "(无主题)",
        "from_addr": "",
        "from_name": "",
        "to_addr": "",
        "date": "",
        "snippet": "",
        "body_text": "",
        "body_html": "",
        "urls": [],
        "attachments": [],
        "headers": {},
        "auth_raw": "",
        "reply_to": "",
        "return_path": "",
        "list_unsubscribe": "",
        "precedence": "",
        "raw_path": "",
    }
    defaults.update(d)
    return EmailDict(defaults)
