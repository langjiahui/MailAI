"""语义检索：开关逻辑、向量索引往返、相似度排序与助手来源合并。"""
import json
import math
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, semantic


def _insert_email(uid, subject, snippet=""):
    with db.conn() as c:
        c.execute(
            "INSERT INTO emails(uid,folder,from_addr,subject,date,snippet,"
            "created_at,remote_missing) VALUES(?,?,?,?,?,?,?,0)",
            (uid, "INBOX", "a@example.com", subject, "2026-09-18T10:00:00",
             snippet, "2026-09-18T10:00:00"),
        )
        return c.execute("SELECT id FROM emails WHERE uid=?", (uid,)).fetchone()[0]


def _fake_embedder(vectors_by_text):
    """按文本返回确定性伪向量。"""
    def embed(texts):
        out = []
        for text in texts:
            vec = vectors_by_text.get(text)
            if vec is None:
                # 未登记文本：用哈希生成确定性的"无关"向量
                seed = sum(text.encode("utf-8")) % 997
                vec = [((seed % 7) - 3) * 0.01] * 512
            out.append(vec)
        return out
    return embed


def main():
    with tempfile.TemporaryDirectory() as root, \
            patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
            patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()

        # 开关：未装依赖 / 未启用时一律关闭
        with patch.object(semantic, "deps_available", return_value=False):
            assert not semantic.enabled()
        with patch.object(semantic, "deps_available", return_value=True):
            assert not semantic.enabled()  # 偏好未开启
            db.set_runtime_setting("user_preferences", json.dumps({"semantic_enabled": True}))
            assert semantic.enabled()

        # 回归：依赖可用但库还没有 runtime_settings 表（极简单测库/迁移中），
        # enabled() 必须安全回落为关闭，而不是抛 OperationalError
        # （CI 打包环境装了 fastembed 后 test_assistant_routing 曾因此失败）。
        with patch.object(semantic, "deps_available", return_value=True), \
                patch.object(db, "get_runtime_settings",
                             side_effect=sqlite3.OperationalError("no such table: runtime_settings")):
            assert not semantic.enabled()

        # 索引与搜索（注入伪嵌入器，不触碰模型与网络）
        id_contract = _insert_email(1, "采购合同交期确认", "请确认合同交付时间")
        id_trip = _insert_email(2, "国庆假期值班表", "值班安排见附件")
        contract_vec = [1.0] + [0.0] * 511
        trip_vec = [0.0, 1.0] + [0.0] * 510
        vectors = {
            "采购合同交期确认\na@example.com\n请确认合同交付时间": contract_vec,
            "国庆假期值班表\na@example.com\n值班安排见附件": trip_vec,
            "合同什么时候交付？": contract_vec,  # 查询与合同向量同向
        }
        with patch.object(semantic, "embed_texts", side_effect=_fake_embedder(vectors)):
            result = semantic.reindex(limit=10)
            assert result["indexed"] == 2, result
            stats = semantic.index_stats()
            assert stats["indexed"] == 2 and stats["last_indexed_at"]
            # 重建完成后进度快照应处于"已结束"状态，供前端停止轮询
            prog = stats["progress"]
            assert prog["running"] is False and prog["done"] == 2 and prog["total"] == 2 and not prog["error"], prog

            hits = semantic.search("合同什么时候交付？", limit=5, min_score=0.9)
            assert hits == [id_contract], hits
            # 低阈值下两篇都返回，但合同在前
            hits = semantic.search("合同什么时候交付？", limit=5, min_score=0.0)
            assert hits[0] == id_contract and id_trip in hits

            # New and edited messages catch up without another full rebuild.
            id_new = _insert_email(3, "合同的补充约定", "交付日期已调整")
            with patch.object(semantic, "enabled", return_value=True):
                assert semantic.index_missing() == 1
                with db.conn() as c:
                    assert c.execute("SELECT 1 FROM email_vectors WHERE email_id=?", (id_new,)).fetchone()
                assert semantic.index_missing() == 0
                db.upsert_email({"uid": 3, "folder": "INBOX", "subject": "调整后的交付日期"})
                with db.conn() as c:
                    assert not c.execute("SELECT 1 FROM email_vectors WHERE email_id=?", (id_new,)).fetchone()
                assert semantic.index_missing() == 1

        # Fast search never invokes semantic inference; AI recall is opt-in.
        from app.web.routes.mail_read import api_search_emails
        with patch.object(semantic, "enabled", return_value=True), \
                patch.object(semantic, "search", return_value=[id_trip]) as ai_search:
            results = api_search_emails("请帮我找合同交付相关邮件")
            assert results == []
            assert all("body_text" not in item for item in results)
            precise = api_search_emails("采购合同")
            assert precise[0]["id"] == id_contract
            ai_search.assert_not_called()

        # 助手 _sources 合并语义命中（关键词检索找不到的也能进上下文）
        from app import mail_assistant
        with patch.object(semantic, "enabled", return_value=True), \
                patch.object(semantic, "search", return_value=[id_trip]):
            rows = mail_assistant._sources("合同交付时间", None)
            ids = [r["id"] for r in rows]
            assert id_contract in ids and id_trip in ids
            # 去重：语义命中与关键词命中同一封时不重复
            with patch.object(semantic, "search", return_value=[id_contract]):
                ids = [r["id"] for r in mail_assistant._sources("合同交付时间", None)]
                assert ids.count(id_contract) == 1

        # 空查询与空索引安全返回
        assert semantic.search("") == []
        with tempfile.TemporaryDirectory() as root2, \
                patch.object(config, "DB_PATH", os.path.join(root2, "empty.db")):
            db.init_db()
            with patch.object(semantic, "embed_texts", side_effect=AssertionError("不应调用模型")):
                assert semantic.search("任何查询") == []

        # 附件正文切片、历史线程脉络与正文续篇统一进入本地语义检索 + 助手问答/搜索上下文
        from email.message import EmailMessage
        from app import attachment_text, mail_assistant
        with tempfile.TemporaryDirectory() as root3, \
                patch.object(config, "DB_PATH", os.path.join(root3, "unified.db")), \
                patch.object(config, "IMAP_USER", "me@example.com"):
            db.init_db()
            db.set_runtime_setting("user_preferences", json.dumps({"semantic_enabled": True}))

            eml_path = Path(root3) / "quote.eml"
            msg = EmailMessage()
            msg["Subject"] = "设备采购补充说明"
            msg.set_content("请查收附件细节。")
            msg.add_attachment(
                "本项目交货期为45个自然日，维保条款含2年现场支持。".encode("utf-8"),
                maintype="text",
                subtype="plain",
                filename="设备报价单.txt",
            )
            eml_path.write_bytes(msg.as_bytes())
            id_quote = db.upsert_email({
                "uid": 101,
                "folder": "INBOX",
                "from_addr": "vendor@example.com",
                "subject": "设备采购补充说明",
                "body_text": "请查收附件细节。",
                "date": "2026-10-10T10:00:00",
                "raw_path": str(eml_path),
                "attachments": [{"name": "设备报价单.txt", "size": 60}],
            })

            # 同会话两封邮件：前信说明项目主题，后信只有简短回复“同意，请按此方案推进。”
            id_thread_root = db.upsert_email({
                "uid": 102,
                "folder": "INBOX",
                "from_addr": "pm@example.com",
                "subject": "东区机房空调改造方案",
                "body_text": "机房制冷改造预算32万元，计划周末割接上线。",
                "snippet": "机房制冷改造预算32万元，计划周末割接上线。",
                "date": "2026-10-11T09:00:00",
                "thread_id": "thread-hvac-1",
            })
            id_thread_reply = db.upsert_email({
                "uid": 103,
                "folder": "INBOX",
                "from_addr": "lead@example.com",
                "subject": "Re: 东区机房空调改造方案",
                "body_text": "同意，请按此方案推进。",
                "snippet": "同意，请按此方案推进。",
                "date": "2026-10-12T09:00:00",
                "thread_id": "thread-hvac-1",
            })

            # 长正文续篇切片（超过 800 字截断区间）
            id_long = db.upsert_email({
                "uid": 104,
                "folder": "INBOX",
                "from_addr": "ops@example.com",
                "subject": "年度运维规范",
                "body_text": ("常规巡检说明。" * 160) + "\n关键暗号：蓝鲸应急预案404，务必提前备份。",
                "date": "2026-10-09T08:00:00",
            })

            # 隔离区邮件及其附件绝不进入语义切片与附件检索
            id_quarantine = db.upsert_email({
                "uid": 105,
                "folder": "Quarantine",
                "status": "quarantine",
                "from_addr": "risk@example.com",
                "subject": "可疑文件",
                "body_text": "请打开附件",
                "date": "2026-10-13T08:00:00",
            })
            attachment_text.save_cache(id_quarantine, 0, "bad-digest", "风险报价.txt", "本项目交货期为45个自然日", "测试")

            att_vec = [1.0, 0.0] + [0.0] * 510
            thread_vec = [0.0, 1.0, 0.0] + [0.0] * 509
            long_vec = [0.0, 0.0, 1.0] + [0.0] * 509
            base_vec = [0.0, 0.0, 0.0, 1.0] + [0.0] * 508

            def smart_embed(texts):
                out = []
                for text in texts:
                    if "45个自然日" in text or "维保条款" in text:
                        out.append(att_vec)
                    elif "机房" in text and ("历史会话" in text or "改造预算" in text):
                        out.append(thread_vec)
                    elif "蓝鲸应急预案404" in text:
                        out.append(long_vec)
                    else:
                        out.append(base_vec)
                return out

            with patch.object(semantic, "deps_available", return_value=True), \
                    patch.object(semantic, "embed_texts", side_effect=smart_embed):
                summary = semantic.reindex(limit=20)
                assert summary["indexed"] == 5, summary
                assert summary["chunks"] >= 4, summary
                stats = semantic.index_stats()
                assert stats["attachment_files"] == 1 and stats["attachment_chunks"] >= 1, stats
                assert stats["thread_chunks"] >= 2 and stats["body_chunks"] >= 1, stats

                # 查询“维保条款有哪些？” -> 命中附件切片并正确归因
                att_hits = semantic.search_hits("维保条款有哪些？", limit=5, min_score=0.8)
                assert [h["email_id"] for h in att_hits] == [id_quote], att_hits
                assert att_hits[0]["match_kind"] == "attachment" and att_hits[0]["source_ref"] == "设备报价单.txt"
                assert "45个自然日" in att_hits[0]["excerpt"]

                # 查询“之前机房改造沟通到哪一步” -> 命中历史线程上下文，即使回复正文只有“同意，请按此方案推进。”
                thread_hits = semantic.search_hits("之前机房改造沟通到哪一步", limit=5, min_score=0.8)
                thread_hit_ids = {h["email_id"] for h in thread_hits}
                assert id_thread_reply in thread_hit_ids, thread_hits

                # 查询“蓝鲸应急预案404” -> 命中超过 800 字的正文续篇切片
                body_hits = semantic.search_hits("蓝鲸应急预案404", limit=5, min_score=0.8)
                assert body_hits and body_hits[0]["email_id"] == id_long and body_hits[0]["match_kind"] == "body", body_hits

                # 更新附件缓存后，增量索引可自动识别并刷新新附件切片
                updated_msg = EmailMessage()
                updated_msg["Subject"] = "设备采购补充说明"
                updated_msg.set_content("请查收附件细节。")
                updated_msg.add_attachment(
                    "新修订：维保条款延至5年，含备件先行替换。".encode("utf-8"),
                    maintype="text",
                    subtype="plain",
                    filename="设备报价单.txt",
                )
                eml_path.write_bytes(updated_msg.as_bytes())
                attachment_text.extract_local(id_quote, 0, cache=True)
                assert semantic.index_missing() >= 1
                refreshed = semantic.search_hits("维保条款有哪些？", limit=5, min_score=0.8)
                assert refreshed[0]["email_id"] == id_quote and "5年" in refreshed[0]["excerpt"], refreshed

                # AI 搜索模式与常规问答均能合并语义+附件缓存，并在提示词里带上附件片段与会话脉络
                search_res = mail_assistant._search_result("维保条款 备件先行替换")
                assert search_res["sources"] and search_res["sources"][0]["id"] == id_quote
                citations = mail_assistant._source_citations(search_res["sources"], with_preview=True)
                assert "命中附件 · 设备报价单.txt" == citations[0]["match_reason"]
                assert "备件先行替换" in citations[0]["preview"]

                with patch.object(mail_assistant.client, "available", return_value=True), \
                        patch.object(mail_assistant.client, "chat_completion",
                                     return_value={"choices": [{"message": {"content": f"已核对维保延至5年。[email_id:{id_quote}]"}}]}) as llm_mock:
                    ans = mail_assistant.ask("维保条款怎么约定？")
                    assert "5年" in ans["answer"]
                    prompt_text = llm_mock.call_args.args[0][-1]["content"]
                    assert "本地已提取附件片段（非全文）：设备报价单.txt" in prompt_text
                    assert "备件先行替换" in prompt_text

                # 验证多封邮件会话上下文也被注入模型输入
                with patch.object(mail_assistant.client, "available", return_value=True), \
                        patch.object(mail_assistant.client, "chat_completion",
                                     return_value={"choices": [{"message": {"content": f"领导已同意推进。[email_id:{id_thread_reply}]"}}]}) as llm_mock2:
                    mail_assistant.ask("这封回复到底同意了什么预算？", email_ids=[id_thread_reply])
                    thread_prompt = llm_mock2.call_args.args[0][-1]["content"]
                    assert "历史会话脉络" in thread_prompt and "预算32万元" in thread_prompt

            # 关闭语义检索时，仅凭已缓存的附件关键字仍能精准找回并带出附件摘录
            with patch.object(semantic, "enabled", return_value=False):
                kw_res = mail_assistant._search_result("备件先行替换")
                assert kw_res["sources"] and kw_res["sources"][0]["id"] == id_quote
                assert id_quarantine not in [r["id"] for r in kw_res["sources"]]

    print("✅ 语义检索开关、索引、切片（附件/线程/长正文）与来源合并测试通过")


if __name__ == "__main__":
    main()
