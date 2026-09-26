"""COS sharing stays account-scoped, never stores secrets in the mail database."""
import asyncio
import sys
import tempfile
import threading
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


async def test_upload_lifecycle():
    paths = []
    entered = threading.Event()
    release = threading.Event()
    class Request:
        headers = {'content-length': '3'}
        async def stream(self):
            yield b'abc'
    def uploading(path, *args):
        paths.append(path)
        if len(paths) == 2:
            entered.set()
        assert release.wait(3)
        assert Path(path).read_bytes() == b'abc', 'canceled caller removed an in-use file'
        return {'url': 'https://example.test/file'}
    with patch.object(share_storage, 'public_config', return_value={'credential_available': True}), \
            patch.object(share_storage, '_upload_file', side_effect=uploading):
        first = asyncio.create_task(share_storage.upload_request(Request(), 'a.txt', 7))
        second = asyncio.create_task(share_storage.upload_request(Request(), 'b.txt', 7))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            first.cancel()
            try:
                await first
            except asyncio.CancelledError:
                pass
            assert all(Path(path).exists() for path in paths)
            try:
                await share_storage.upload_request(Request(), 'c.txt', 7)
            except share_storage.UploadBusyError:
                pass
            else:
                raise AssertionError('unbounded concurrent uploads')
        finally:
            release.set()
            await second
            await asyncio.gather(*list(share_storage._uploads))
        assert all(not Path(path).exists() for path in paths)
        # Both permits are returned after background cleanup.
        assert share_storage._upload_slots.acquire(False)
        assert share_storage._upload_slots.acquire(False)
        share_storage._upload_slots.release()
        share_storage._upload_slots.release()

        class Oversize(Request):
            headers = {'content-length': str(share_storage._MAX_FILE_BYTES + 1)}
            async def stream(self):
                raise AssertionError('read oversized request')
                yield b''
        try:
            await share_storage.upload_request(Oversize(), 'big.txt', 7)
        except ValueError:
            pass
        else:
            raise AssertionError('oversized header accepted')
        class Truncated(Request):
            headers = {'content-length': '9'}
        with patch.object(share_storage, '_upload_file') as upload:
            try:
                await share_storage.upload_request(Truncated(), 'short.txt', 7)
            except ValueError:
                pass
            else:
                raise AssertionError('truncated file accepted')
            upload.assert_not_called()


if __name__ == "__main__":
    test_config_and_upload()
    asyncio.run(test_upload_lifecycle())
    print('COS isolation, upload limits, cancellation and temporary-file cleanup passed')
