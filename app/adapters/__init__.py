"""输入适配器：统一不同消息来源（IMAP、企业微信、钉钉等）。"""
from .base import BaseInputAdapter, EmailDict
from .imap import ImapAdapter

__all__ = ["BaseInputAdapter", "EmailDict", "ImapAdapter"]
