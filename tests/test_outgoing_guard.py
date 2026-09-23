"""常规发送只执行本地检查，模糊提醒不阻断发信。"""
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
    result = outgoing_guard.review(payload, recipients)
    codes = {item["code"] for item in result["issues"]}
    assert {"MISSING_ATTACHMENT", "REPLY_ALL_EXTERNAL", "EXTERNAL_PAYMENT"} <= codes
    assert "EXTERNAL_RECIPIENT" not in codes and "NEW_RECIPIENT" not in codes
    assert result["ok"] is False and result["ai_reviewed"] is False

    no_attachment_promised = {**payload, "body_text": "附件将另行提供，这封邮件无需附件。"}
    assert not any(item["code"] == "MISSING_ATTACHMENT" for item in outgoing_guard.local_issues(no_attachment_promised, recipients))

    safe = {"subject": "项目进度", "body_text": "本周工作正常", "attachment_names": [], "mode": "compose"}
    result = outgoing_guard.review(safe, ["user@example.com"])
    assert result["ok"] is True and result["issues"] == []
    assert result["ai_reviewed"] is False

    risky_source = {"id": 9, "score": 80, "verdict": "phishing", "recommended_status": "quarantine",
                    "feedback": "", "findings": [{"code": "CRED_BAIT", "detail": "诱导输入密码", "weight": 20}]}
    with patch.object(outgoing_guard.db, "get_email", return_value=risky_source):
        issues = outgoing_guard.local_issues({**safe, "mode": "reply", "reply_to_email_id": 9}, ["user@example.com"])
    source_issue = next(item for item in issues if item["code"] == "RISKY_SOURCE_MAIL")
    assert source_issue["level"] == "danger" and "原邮件风险分 80" in source_issue["reason"]
    print("✅ 发信前精简本地检查通过")


if __name__ == "__main__":
    main()
