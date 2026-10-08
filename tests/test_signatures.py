"""Signature persistence, sanitization and AI candidate rendering."""
import os
import base64
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, signatures
from app.smtp_client import _prepare_inline_images


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

        # A realistic embedded image is much larger than the old 50K HTML cap.
        payload = b'\x89PNG\r\n\x1a\n' + b'picture' * 12_000
        image = 'data:image/png;base64,' + base64.b64encode(payload).decode()
        picture = signatures.save({"name": "图文签名", "html": f'<p>甲<img src="{image}" alt="标志">乙</p>'})
        saved_html = picture['items'][-1]['html']
        assert image in signatures.load()['items'][-1]['html']
        rendered, inline = _prepare_inline_images(saved_html)
        assert '甲<img' in rendered and '乙</p>' in rendered
        assert len(inline) == 1 and inline[0][0] == payload and 'cid:' in rendered
        try:
            signatures.save({"name": "无效", "html": '<img src="data:image/svg+xml;base64,PHN2Zz4="/>'})
        except ValueError as exc:
            assert '格式无效' in str(exc)
        else:
            raise AssertionError('Unsafe embedded signature image was accepted')

        with patch.object(signatures.llm_client, "chat_json", return_value={"options": [
            {"name": "专业版", "closing": "顺颂商祺", "tagline": "让复杂协作更简单"},
        ]}):
            options = signatures.generate({"name": "张三", "email": "sender@example.com"})
        assert options[0]["name"] == "专业版"
        assert "张三" in options[0]["html"] and "mailto:sender@example.com" in options[0]["html"]

        signatures.delete(picture['items'][-1]['id'])
        empty = signatures.delete(state["items"][0]["id"])
        assert empty["items"] == [] and empty["default_id"] == ""
    print("✅ 签名保存、清理与 AI 候选测试通过")


if __name__ == "__main__":
    main()
