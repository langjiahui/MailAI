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

            hits = semantic.search("合同什么时候交付？", limit=5, min_score=0.9)
            assert hits == [id_contract], hits
            # 低阈值下两篇都返回，但合同在前
            hits = semantic.search("合同什么时候交付？", limit=5, min_score=0.0)
            assert hits[0] == id_contract and id_trip in hits

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

    print("✅ 语义检索开关、索引、排序与来源合并测试通过")


if __name__ == "__main__":
    main()
