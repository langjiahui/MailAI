"""Recipient communication personas, role presets, signatures, memory matching, and compose/followup integration."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, recipient_profiles, signatures, work_assistant as work, work_memory
from app.account_context import use
from app.llm import client
from app.web.routes.compose import _compose_assist_context
from app.web.schemas import ComposeAssistRequest


def main():
    with tempfile.TemporaryDirectory() as root:
        account_a = dict(
            ACCOUNT_ID="persona-a",
            DB_PATH=str(Path(root) / "a.db"),
            DATA_DIR=str(Path(root) / "a"),
            IMAP_USER="me@corp.test",
        )
        account_b = dict(
            ACCOUNT_ID="persona-b",
            DB_PATH=str(Path(root) / "b.db"),
            DATA_DIR=str(Path(root) / "b"),
            IMAP_USER="me@other.test",
        )
        with use(account_a):
            db.init_db()
            s1 = signatures.save({"name": "管理汇报签名", "html": "<div><strong>李华</strong> · 技术部</div>"}, make_default=True)
            leader_sig_id = s1["items"][0]["id"]
            s2 = signatures.save({"name": "商务对外签名", "html": "<div><strong>李华</strong> · 客户合作</div>"})
            cust_sig_id = next(item["id"] for item in s2["items"] if item["name"] == "商务对外签名")

            # Role presets validate and bind per-role signature + tone
            presets = recipient_profiles.save_role_presets({
                "leader": {
                    "tone": "正式",
                    "salutation_hint": "XX总您好：",
                    "style_hint": "先给结论与风险，避免冗长铺垫。",
                    "signature_id": leader_sig_id,
                },
                "customer": {
                    "tone": "友好",
                    "salutation_hint": "尊敬的客户您好：",
                    "style_hint": "礼貌清晰说明交付节点。",
                    "signature_id": cust_sig_id,
                },
            })
            assert presets["leader"]["signature_id"] == leader_sig_id
            assert presets["customer"]["signature_id"] == cust_sig_id
            assert presets["customer"]["followup_tone"] == "polite"
            try:
                recipient_profiles.save_role_presets({"leader": {"tone": "正式", "signature_id": "missing-sig"}})
                raise AssertionError("Nonexistent signature should fail validation")
            except ValueError:
                pass

            # Inferred role from directory profile & corporate domain
            db.save_contact(
                "boss@corp.test",
                name="张敏",
                company="集团总部",
                profile={"department": "研发中心", "title": "技术总监"},
            )
            db.save_contact(
                "vip@client.example",
                name="王总",
                company="星海科技",
                group_name="客户",
                note="重点客户接口人",
                comm_profile={
                    "role_key": "customer",
                    "salutation": "王总您好：",
                    "tone": "正式",
                    "writing_hint": "对外统一称呼贵司，附件附上正式盖章版。",
                    "signature_id": cust_sig_id,
                },
            )
            db.save_contact("peer@corp.test", name="赵强")

            res_boss = recipient_profiles.resolve_for_recipients("张敏 <boss@corp.test>")
            eff_boss = res_boss["effective"]
            assert eff_boss["role_key"] == "leader" and eff_boss["role_source"] == "inferred"
            assert eff_boss["signature_id"] == leader_sig_id
            assert eff_boss["tone"] == "正式"
            assert "技术总监" in eff_boss["contact_summary"]

            res_peer = recipient_profiles.resolve_for_recipients("peer@corp.test")
            assert res_peer["effective"]["role_key"] == "colleague"
            assert res_peer["effective"]["role_source"] == "inferred"
            assert res_peer["effective"]["tone"] == "简洁"

            # Multi-recipient priority: explicit customer + inferred colleague or leader prioritizes highest role
            res_multi = recipient_profiles.resolve_for_recipients("peer@corp.test, boss@corp.test")
            assert res_multi["effective"]["role_key"] == "leader"
            assert res_multi["effective"]["signature_id"] == leader_sig_id

            # Work memory integration matches role/contact while respecting enabled state & opt-out
            conv = db.create_assistant_conversation("领导汇报习惯")
            quote = "给张敏张总汇报时，所有数值都附同比变化。"
            db.add_assistant_message(conv, "user", quote)
            mem_settings = work_memory.settings()
            work_memory.save_personal({
                "kind": "communication",
                "preference": quote,
                "source_quote": quote,
                "memory_revision": mem_settings["revision"],
            })

            res_mem = recipient_profiles.resolve_for_recipients("boss@corp.test", include_memories=True)
            assert any("同比变化" in m for m in res_mem["effective"]["matched_memories"])
            res_no_mem = recipient_profiles.resolve_for_recipients("boss@corp.test", include_memories=False)
            assert res_no_mem["effective"]["matched_memories"] == []

            # Compose assist respects recipient context + use_work_preferences opt-out
            messages, basis, _ = _compose_assist_context(ComposeAssistRequest(
                operation="draft",
                recipients="vip@client.example",
                use_work_preferences=True,
                user_instruction="同步本周上线安排",
            ))
            prompt_text = json.dumps(messages, ensure_ascii=False)
            assert "收件人画像与角色预设" in basis
            assert "王总您好：" in prompt_text and "对外统一称呼贵司" in prompt_text

            messages_optout, basis_optout, _ = _compose_assist_context(ComposeAssistRequest(
                operation="draft",
                recipients="boss@corp.test",
                use_work_preferences=False,
                user_instruction="汇报测试进展",
            ))
            assert "同比变化" not in json.dumps(messages_optout, ensure_ascii=False)
            assert "收件人画像与角色预设" in basis_optout  # contact card from checked recipients

            messages_no_rcpt, basis_no_rcpt, _ = _compose_assist_context(ComposeAssistRequest(
                operation="draft",
                recipients="",
                use_work_preferences=True,
                user_instruction="随便写点内容",
            ))
            assert "收件人画像与角色预设" not in basis_no_rcpt
            assert "王总您好：" not in json.dumps(messages_no_rcpt, ensure_ascii=False)

            # Follow-up seed + draft auto-match persona tone, signature, and custom salutation
            sent_id = db.create_sent_message({
                "to_addr": "vip@client.example",
                "cc_addr": "",
                "bcc_addr": "",
                "subject": "项目合作方案确认",
                "body_html": "<p>请查收合作方案。</p>",
                "message_id": "<sent-vip-1@corp.test>",
            })
            db.finish_sent_message(sent_id, ok=True, message_id="<sent-vip-1@corp.test>", sent_folder="Sent")
            seed = work.followup_seed(sent_id)
            assert seed["signature_id"] == cust_sig_id
            assert seed["recipient_persona"]["salutation"] == "王总您好："
            with patch.object(client, "available", return_value=False):
                draft = work.followup_draft(sent_id, tone="auto", use_work_preferences=True)
            assert draft["tone"] == "formal"  # customer contact has explicit tone='正式' -> 'formal'
            assert draft["signature_id"] == cust_sig_id
            assert draft["draft_body"].startswith("王总您好：")
            assert "收件人画像" in draft["basis"]

            # Upsert persona directly for a new address creates searchable contact
            updated = recipient_profiles.upsert_contact_persona("newvendor@partner.example", {
                "role_key": "partner",
                "salutation": "供应商团队您好：",
                "tone": "坚定",
                "writing_hint": "注明交付物清单",
                "signature_id": "",
            })
            assert updated["effective"]["role_key"] == "partner"
            found = db.search_contacts("newvendor@partner.example", 5)
            assert found and found[0]["persona"]["role_key"] == "partner"
            assert found[0]["comm_profile"]["salutation"] == "供应商团队您好："

            # Assistant context respects memory enable/disable switch
            ctx = recipient_profiles.assistant_context("帮我给王总写一封回复说明进度")
            assert "王总您好：" in ctx and "客户" in ctx
            mem_state = work_memory.settings()
            work_memory.save_settings(False, False, mem_state["revision"])
            assert recipient_profiles.assistant_context("帮我给王总写一封回复") == ""

        # Account isolation check
        with use(account_b):
            db.init_db()
            res_b = recipient_profiles.resolve_for_recipients("vip@client.example")
            assert not res_b["effective"]["has_context"]
            assert res_b["presets"]["leader"]["signature_id"] == ""

    print("PASS recipient profiles, role presets, signature matching, memory bounds, compose/followup integration and account isolation")


if __name__ == "__main__":
    main()
