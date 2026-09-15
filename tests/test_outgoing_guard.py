"""发信前守门员应可本地工作，并在 AI 不可用时平稳降级。"""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import outgoing_guard


def main():
    payload = {
        "subject": "付款材料", "body_text": "请见附件，并向新账号付款",
        "attachment_names": [], "attachment_count": 0, "mode": "reply_all",
    }
    recipients = ["new-contact@external.example"]
    with patch.object(outgoing_guard.db, "contact_history", return_value={recipients[0]: 0}), \
         patch.object(outgoing_guard.llm_client, "available", return_value=False):
        result = outgoing_guard.review(payload, recipients)
    codes = {item["code"] for item in result["issues"]}
    assert {"MISSING_ATTACHMENT", "EXTERNAL_RECIPIENT", "REPLY_ALL_EXTERNAL", "EXTERNAL_PAYMENT", "NEW_RECIPIENT"} <= codes
    assert result["ok"] is False and result["ai_reviewed"] is False

    safe = {"subject": "项目进度", "body_text": "本周工作正常", "attachment_names": [], "mode": "compose"}
    with patch.object(outgoing_guard.db, "contact_history", return_value={"user@baosight.com": 3}), \
         patch.object(outgoing_guard.llm_client, "available", return_value=True), \
         patch.object(outgoing_guard.llm_client, "chat_json", return_value=None) as request:
        result = outgoing_guard.review(safe, ["user@baosight.com"])
    assert result["ok"] is True and any(i["code"] == "AI_REVIEW_UNAVAILABLE" for i in result["issues"])
    assert request.call_count == 1
    assert request.call_args.kwargs == {"max_retries": 0, "timeout": 8}
    with patch.object(outgoing_guard.llm_client, "chat_completion", return_value=None) as completion:
        assert outgoing_guard.llm_client.chat_json("system", "body", max_retries=0, timeout=8) is None
        assert completion.call_count == 1
        assert completion.call_args.kwargs["timeout"] == 8

    risky_source = {"id": 9, "score": 80, "verdict": "phishing", "recommended_status": "quarantine",
                    "feedback": "", "findings": [{"code": "CRED_BAIT", "detail": "诱导输入密码", "weight": 20}]}
    with patch.object(outgoing_guard.db, "get_email", return_value=risky_source), \
         patch.object(outgoing_guard.db, "contact_history", return_value={"user@baosight.com": 2}):
        issues = outgoing_guard.local_issues({**safe, "mode": "reply", "reply_to_email_id": 9}, ["user@baosight.com"])
    source_issue = next(item for item in issues if item["code"] == "RISKY_SOURCE_MAIL")
    assert source_issue["level"] == "danger" and "原邮件风险分 80" in source_issue["reason"]
    print("✅ 发信前安全守门员与降级逻辑通过")


if __name__ == "__main__":
    main()
