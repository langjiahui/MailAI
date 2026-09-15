"""Signature persistence, sanitization and AI candidate rendering."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, signatures


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
         patch.object(config, "IMAP_USER", "sender@example.com"):
        db.init_db()
        state = signatures.save({"name": "工作签名", "html": '<b onclick="bad()">张三</b><script>bad()</script>'},
                                {"name": "张三", "title": "产品经理"}, True)
        assert len(state["items"]) == 1
        assert "onclick" not in state["items"][0]["html"] and "script" not in state["items"][0]["html"]
        assert state["default_id"] == state["items"][0]["id"]
        assert signatures.load()["profile"]["name"] == "张三"

        with patch.object(signatures.llm_client, "chat_json", return_value={"options": [
            {"name": "专业版", "closing": "顺颂商祺", "tagline": "让复杂协作更简单"},
        ]}):
            options = signatures.generate({"name": "张三", "email": "sender@example.com"})
        assert options[0]["name"] == "专业版"
        assert "张三" in options[0]["html"] and "mailto:sender@example.com" in options[0]["html"]

        empty = signatures.delete(state["items"][0]["id"])
        assert empty["items"] == [] and empty["default_id"] == ""
    print("✅ 签名保存、清理与 AI 候选测试通过")


if __name__ == "__main__":
    main()
