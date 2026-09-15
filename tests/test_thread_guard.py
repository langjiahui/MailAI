"""会话参与方与意图突变检测。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.security import thread_guard


def main():
    history = [{
        "from_addr": "采购部 <buyer@partner.example>",
        "subject": "季度采购确认", "body_text": "请确认交付日期", "urls": [], "attachments": [],
    }]
    benign = {"from_addr": "buyer@partner.example", "subject": "回复：季度采购确认",
              "body_text": "交付日期没有变化", "urls": [], "attachments": []}
    assert thread_guard.detect(benign, history) == []

    hijacked = {
        "from_addr": "财务支持 <finance@partn3r-security.example>",
        "subject": "回复：季度采购确认",
        "body_text": "请立即点击链接并变更收款账号后转账", 
        "urls": ["https://account-check.example/login"], "attachments": [],
    }
    codes = {item["code"] for item in thread_guard.detect(hijacked, history)}
    assert {"THREAD_SENDER_SHIFT", "THREAD_INTENT_SHIFT", "THREAD_LINK_SHIFT"} <= codes
    assert thread_guard.detect(hijacked, []) == []
    print("✅ 会话劫持与意图突变检测通过")


if __name__ == "__main__":
    main()
