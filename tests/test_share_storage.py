"""COS sharing stays account-scoped, never stores secrets in the mail database."""
import asyncio
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, share_storage


def test_config_and_upload():
    with tempfile.TemporaryDirectory(prefix="mailai-cos-test-") as root:
        secrets = {}
        def save(name, value):
            secrets[name] = value
            return True
        with patch.object(config, "DB_PATH", str(Path(root) / "mail.db")), \
             patch.object(share_storage, "_account_id", return_value="test-account"), \
             patch.object(share_storage.credential_store, "save", side_effect=save), \
             patch.object(share_storage.credential_store, "load", side_effect=lambda name: secrets.get(name, "")), \
             patch.object(share_storage.credential_store, "available", return_value=True):
            db.init_db()
            settings = share_storage.save_config("example-1250000000", "ap-guangzhou", "AKID0123456789", "private-key")
            assert settings["credential_available"]
            assert "private-key" not in str(db.get_runtime_settings())
            uploaded = {}
            class Client:
                def upload_file(self, **kwargs):
                    uploaded.update(kwargs)
                    assert Path(kwargs["LocalFilePath"]).read_bytes() == b"test payload"
                def get_presigned_download_url(self, **kwargs):
                    return "https://example.cos.ap-guangzhou.myqcloud.com/file?signature=token"
            class Request:
                async def stream(self):
                    yield b"test "
                    yield b"payload"
            with patch.object(share_storage, "_client", return_value=Client()):
                result = asyncio.run(share_storage.upload_request(Request(), "report%20draft.pdf", 7))
            assert result["name"] == "report draft.pdf" and result["size"] == 12
            assert result["url"].startswith("https://")
            assert uploaded["Bucket"] == "example-1250000000"
            assert uploaded["Key"].startswith("mailai-shares/")
            assert not Path(uploaded["LocalFilePath"]).exists()


if __name__ == "__main__":
    test_config_and_upload()
