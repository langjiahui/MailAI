import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.security import policy


def test_present_findings_explains_common_technical_signals():
    findings = policy.present_findings([
        {"code": "AUTH_NONE", "detail": "无 Authentication-Results 认证信息", "weight": 5},
        {"code": "DISPLAY_SPOOF", "detail": "外部邮件显示名冒称内部身份: EPLAT系统管理员", "weight": 20},
        {"code": "DNS_SPF", "detail": "发件域 baosteel.com 未配置 SPF", "weight": 5},
        {"code": "URL_ANOMALY", "detail": "该发件人历史很少发送 URL，本邮件包含 10 个链接", "weight": 10},
    ])

    assert all(item["technical_code"] != "AUTH_NONE" for item in findings)
    assert "EPLAT系统管理员" in findings[0]["explanation"]
    assert "baosteel.com" in findings[1]["explanation"]
    assert "10 个链接" in findings[2]["explanation"]


def test_present_findings_keeps_dynamic_evidence_for_other_rules():
    result = policy.present_findings([
        {"code": "URL_SHORT", "detail": "发现短链接 t.cn/abc", "weight": 10},
    ])[0]

    assert result["title"] == "短链接"
    assert result["explanation"] == "发现短链接 t.cn/abc"
    assert result["technical_code"] == "URL_SHORT"


def main():
    test_present_findings_explains_common_technical_signals()
    test_present_findings_keeps_dynamic_evidence_for_other_rules()
    print("✅ 安全发现用户文案测试通过")


if __name__ == "__main__":
    main()
