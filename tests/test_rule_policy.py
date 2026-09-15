"""规则中心动态启停、权重与阈值持久化测试。"""
import os
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db
from app.security import chains, policy, rules, urls


def main():
    old_db = config.DB_PATH
    with tempfile.TemporaryDirectory() as td:
        config.DB_PATH = os.path.join(td, "rules.db")
        try:
            db.init_db()
            source = [
                {"code": "SPF_FAIL", "detail": "fail", "weight": 25},
                {"code": "URL_IP", "detail": "ip", "weight": 15},
            ]
            assert sum(x["weight"] for x in policy.apply(source)) == 40

            db.set_rule_setting("SPF_FAIL", False, 60)
            applied = policy.apply(source)
            assert [x["code"] for x in applied] == ["URL_IP"]

            db.set_rule_setting("SPF_FAIL", True, 60)
            applied = policy.apply(source)
            assert sum(x["weight"] for x in applied) == 75

            db.set_runtime_setting("review_score", "30")
            db.set_runtime_setting("quarantine_score", "80")
            assert policy.thresholds()["review_score"] == 30
            assert policy.thresholds()["quarantine_score"] == 80

            rule_catalog = {r["code"]: r for r in policy.list_rules()}
            assert "AUTH_NONE" not in rule_catalog
            assert set(policy.TRIGGER_GUIDE) == set(policy.CATALOG)
            assert all(item["trigger"] and item["allowlist_behavior"] for item in rule_catalog.values())
            assert rule_catalog["SPF_FAIL"]["customized"] is True
            assert rule_catalog["SPF_FAIL"]["weight"] == 60

            trusted = db.upsert_security_allowlist("partner.example.com", True, "长期合作方")
            assert trusted["domain"] == "partner.example.com"
            matched = policy.allowlist_match("Partner <notice@sub.partner.example.com>")
            assert matched and matched["domain"] == "partner.example.com"
            filtered = policy.apply_allowlist([
                {"code": "URGENCY", "detail": "业务催办", "weight": 10},
                {"code": "FIRST_TIME_SENDER", "detail": "首次来信", "weight": 10},
                {"code": "ATT_MACRO", "detail": "宏附件", "weight": 35},
            ], matched)
            assert [item["code"] for item in filtered] == ["ATT_MACRO"]
            assert policy.normalize_domain("https://例子.测试/path").startswith("xn--")
            address = db.upsert_security_allowlist_address("person@partner.example.com", True, "仅此联系人")
            matched_address = policy.allowlist_match("Person <person@partner.example.com>")
            assert matched_address and matched_address["kind"] == "address"
            assert db.delete_security_allowlist_address(address["id"])

            configured = policy.configure_category("行为画像", True, "relaxed")
            assert configured and all(item["enabled"] for item in configured)
            assert all(item["weight"] <= item["default_weight"] for item in configured)
            categories = {item["category"]: item for item in policy.list_categories()}
            assert categories["行为画像"]["sensitivity"] == "relaxed"
            assert db.delete_security_allowlist(trusted["id"])
            assert policy.allowlist_match("notice@partner.example.com") is None
            assert policy.allowlist_match("build@gitlab.baocloud.cn")["domain"] == "gitlab.baocloud.cn"
            assert policy.allowlist_match("notice@sub.baosteel.com")["domain"] == "baosteel.com"
            assert policy.is_trusted_domain("gitlab.baocloud.cn")
            assert policy.is_trusted_domain("files.baosteel.com")
            effective = {item["value"]: item for item in policy.list_allowlist_entries()}
            assert effective["gitlab.baocloud.cn"]["source"] == "内置白名单"
            assert effective["baosteel.com"]["readonly"] is True
            assert effective[config.COMPANY_DOMAIN]["source"] == "企业域名"
            scan = rules.scan({"from_addr": "notice@baosteel.com", "auth_raw": "", "urls": [],
                               "attachments": [], "subject": "业务通知", "body_text": ""})
            assert not any(item["code"] == "AUTH_NONE" for item in scan["findings"])
            assert urls.analyze_url("https://gitlab.baocloud.cn/group/project") == []
            trusted_result = {"status": "ok", "chain": [{"url": "https://t.cn/a", "status": 200}],
                              "final_url": "https://files.baosteel.com/a", "final_domain": "files.baosteel.com",
                              "final_ip": "10.1.2.3"}
            with patch.object(chains, "follow_redirects", return_value=trusted_result):
                chain_findings, result = chains.analyze_url_chain("https://t.cn/a")
            assert chain_findings == [] and result["trusted_final"] is True
        finally:
            config.DB_PATH = old_db
    print("✅ 规则动态配置测试通过")


if __name__ == "__main__":
    main()
