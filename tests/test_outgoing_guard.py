"""常规发送只执行本地检查，模糊提醒不阻断发信，同时覆盖多维发信前自检规则。"""
import sys
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, outgoing_guard
from app.web.routes import compose
from app.web.schemas import MailPreflightRequest


def main():
    ref_friday = date(2026, 11, 13)  # Friday

    # 1. Existing core assertions
    payload = {
        "subject": "付款材料", "body_text": "请见附件，并向新账号付款",
        "attachment_names": [], "attachment_count": 0, "mode": "reply_all",
    }
    recipients = ["new-contact@external.example"]
    result = outgoing_guard.review(payload, recipients, today=ref_friday)
    codes = {item["code"] for item in result["issues"]}
    assert {"MISSING_ATTACHMENT", "REPLY_ALL_EXTERNAL", "EXTERNAL_PAYMENT"} <= codes
    assert "EXTERNAL_RECIPIENT" not in codes and "NEW_RECIPIENT" not in codes
    assert result["ok"] is False and result["ai_reviewed"] is False

    no_attachment_promised = {**payload, "body_text": "附件将另行提供，这封邮件无需附件。"}
    assert not any(
        item["code"] == "MISSING_ATTACHMENT"
        for item in outgoing_guard.local_issues(no_attachment_promised, recipients, today=ref_friday)
    )

    safe = {"subject": "项目进度", "body_text": "本周工作正常", "attachment_names": [], "mode": "compose"}
    result = outgoing_guard.review(safe, ["user@example.com"], today=ref_friday)
    assert result["ok"] is True and result["issues"] == []
    assert result["ai_reviewed"] is False

    risky_source = {
        "id": 9, "score": 80, "verdict": "phishing", "recommended_status": "quarantine",
        "feedback": "", "findings": [{"code": "CRED_BAIT", "detail": "诱导输入密码", "weight": 20}],
    }
    with patch.object(outgoing_guard.db, "get_email", return_value=risky_source):
        issues = outgoing_guard.local_issues(
            {**safe, "mode": "reply", "reply_to_email_id": 9}, ["user@example.com"], today=ref_friday
        )
    source_issue = next(item for item in issues if item["code"] == "RISKY_SOURCE_MAIL")
    assert source_issue["level"] == "danger" and "原邮件风险分 80" in source_issue["reason"]

    # 2. Date / weekday consistency & stale deadlines
    bad_weekday = outgoing_guard.local_issues(
        {"subject": "会议通知", "body_text": "定于11月14日（周三）下午两点召开评审会", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    mismatch = next(item for item in bad_weekday if item["code"] == "DATE_WEEKDAY_MISMATCH")
    assert mismatch["level"] == "warn" and "周六" in mismatch["message"]

    good_weekday = outgoing_guard.local_issues(
        {"subject": "会议通知", "body_text": "定于11月14日（周六）召开评审会", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert not any(item["code"] in ("DATE_WEEKDAY_MISMATCH", "STALE_DATE_CONFLICT") for item in good_weekday)

    stale_week = outgoing_guard.local_issues(
        {"subject": "材料提醒", "body_text": "请于本周一下班前提交", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert any(item["code"] == "STALE_DATE_CONFLICT" and item["level"] == "warn" for item in stale_week)

    retro_week = outgoing_guard.local_issues(
        {"subject": "上周回顾", "body_text": "我们已于本周一完成上线验证。", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert not any(item["code"] == "STALE_DATE_CONFLICT" for item in retro_week)

    stale_deadline = outgoing_guard.local_issues(
        {"subject": "进度督办", "body_text": "请务必在11月10日前完成登记。", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert any(item["code"] == "STALE_DATE_CONFLICT" for item in stale_deadline)

    # 3. Secret / credential leak vs masked placeholder (non-blocking warn + tone=high + exact highlight)
    raw_token = "-".join(["sk", "proj", "Sample" + "Token" + "99887766"])
    secret_hit = outgoing_guard.review(
        {"subject": "配置信息", "body_text": f"测试密钥：{raw_token}\npassword=SuperSecretPass99", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert secret_hit["ok"] is True
    secret_issue = next(item for item in secret_hit["issues"] if item["code"] == "SECRET_CREDENTIAL_LEAK")
    assert secret_issue["level"] == "warn" and secret_issue["tone"] == "high"
    assert raw_token not in secret_issue["reason"] and "SuperSecretPass99" not in secret_issue["reason"]
    assert any(h["scope"] == "body" and h["text"] == raw_token for h in secret_issue["highlights"])

    masked_ok = outgoing_guard.local_issues(
        {"subject": "脱敏说明", "body_text": "测试密码：********，API Key：<placeholder>", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert not any(item["code"] == "SECRET_CREDENTIAL_LEAK" for item in masked_ok)

    # 4. PII checksum validation (GB 11643-1999 & Luhn)
    valid_id = "110105199001011232"
    invalid_id = "110105199001011230"
    valid_card = "6222020200001235"

    pii_external = outgoing_guard.local_issues(
        {"subject": "信息核对", "body_text": f"身份证 {valid_id} 卡号 {valid_card}", "mode": "compose"},
        ["partner@external.example"],
        today=ref_friday,
    )
    pii_ext_issue = next(item for item in pii_external if item["code"] == "PII_SENSITIVE_DATA")
    assert pii_ext_issue["level"] == "warn" and pii_ext_issue["tone"] == "high"

    with patch.object(config, "COMPANY_DOMAIN", "corp.example"):
        pii_internal = outgoing_guard.local_issues(
            {"subject": "信息核对", "body_text": f"身份证 {valid_id}", "mode": "compose"},
            ["colleague@corp.example"],
            today=ref_friday,
        )
        pii_int_issue = next(item for item in pii_internal if item["code"] == "PII_SENSITIVE_DATA")
        assert pii_int_issue["level"] == "warn" and pii_int_issue["tone"] == "warn"

        no_pii = outgoing_guard.local_issues(
            {"subject": "单号反馈", "body_text": f"流水号 {invalid_id}", "mode": "compose"},
            ["partner@external.example"],
            today=ref_friday,
        )
        assert not any(item["code"] == "PII_SENSITIVE_DATA" for item in no_pii)

        # 5. Mass visible recipients without Bcc
        many_visible = [f"u{i}@external.example" for i in range(8)]
        mass_warn = outgoing_guard.local_issues(
            {
                "subject": "活动邀请",
                "body_text": "欢迎参加交流会。",
                "to_addr": ", ".join(many_visible),
                "cc_addr": "",
                "bcc_addr": "",
                "mode": "compose",
            },
            many_visible,
            today=ref_friday,
        )
        assert any(item["code"] == "MASS_RECIPIENTS_EXPOSED" and item["level"] == "warn" for item in mass_warn)

        with_bcc = outgoing_guard.local_issues(
            {
                "subject": "活动邀请",
                "body_text": "欢迎参加交流会。",
                "to_addr": "host@corp.example",
                "cc_addr": "",
                "bcc_addr": ", ".join(many_visible),
                "mode": "compose",
            },
            ["host@corp.example", *many_visible],
            today=ref_friday,
        )
        assert not any(item["code"] == "MASS_RECIPIENTS_EXPOSED" for item in with_bcc)

    # 6. Unfilled template placeholders vs harmless bracket tags / URLs
    placeholder_hit = outgoing_guard.local_issues(
        {"subject": "【通知】项目汇报", "body_text": "您好 {{姓名}}，预算金额：【待补充】，网址 https://example.com/a____b", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    ph_issue = next(item for item in placeholder_hit if item["code"] == "UNFILLED_PLACEHOLDER")
    assert ph_issue["level"] == "warn" and ph_issue["tone"] == "high" and "{{姓名}}" in ph_issue["reason"]
    assert any(h["scope"] == "body" and h["text"] == "{{姓名}}" for h in ph_issue["highlights"])

    harmless_tag = outgoing_guard.local_issues(
        {"subject": "【通知】周报提醒", "body_text": "详情参见 https://example.com/a____b，谢谢。", "mode": "compose"},
        ["user@example.com"],
        today=ref_friday,
    )
    assert not any(item["code"] == "UNFILLED_PLACEHOLDER" for item in harmless_tag)

    # 7. FastAPI /api/mail/preflight allow_empty_recipients contract
    try:
        compose.api_mail_preflight(MailPreflightRequest(subject="测试", body_text="正文"))
        raise AssertionError("Expected HTTPException(400) when recipients are empty")
    except HTTPException as exc:
        assert exc.status_code == 400
    resp_audit = compose.api_mail_preflight(
        MailPreflightRequest(subject="草稿", body_text="您好【待补充】", allow_empty_recipients=True)
    )
    audit_codes = {item["code"] for item in resp_audit["issues"]}
    assert {"EMPTY_RECIPIENTS", "UNFILLED_PLACEHOLDER"} <= audit_codes

    print("✅ 发信前精简本地检查与多维扩展检查全部通过")


if __name__ == "__main__":
    main()
