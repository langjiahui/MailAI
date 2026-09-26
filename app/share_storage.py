"""Optional Tencent COS transport for files shared as links in outgoing mail."""
import asyncio
import json
import os
import re
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

from . import config, credential_store, db, system_settings

_SETTING = "cos_share_config"
_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
_upload_slots = threading.BoundedSemaphore(2)
_uploads = set()


class UploadBusyError(RuntimeError):
    pass


def _account_id() -> str:
    return getattr(config, "ACCOUNT_ID", "") or system_settings._account_key(config.IMAP_HOST, config.IMAP_USER)


def _secret_name() -> str:
    return "cos-share:" + _account_id()


def public_config() -> dict:
    raw = db.get_runtime_settings().get(_SETTING, "")
    try:
        saved = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    return {
        "bucket": saved.get("bucket", ""),
        "region": saved.get("region", ""),
        "secret_id": saved.get("secret_id", ""),
        "credential_available": bool(saved.get("bucket") and saved.get("region") and saved.get("secret_id")
                                     and credential_store.load(_secret_name())),
        "keychain_available": credential_store.available(),
    }


def save_config(bucket: str, region: str, secret_id: str, secret_key: str = "") -> dict:
    bucket, region, secret_id = bucket.strip(), region.strip(), secret_id.strip()
    secret_key = secret_key.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}-\d{5,15}", bucket):
        raise ValueError("存储桶名称格式不正确，请填写 bucket-appid")
    if not re.fullmatch(r"[a-z]{2,8}-[a-z0-9-]{2,24}", region):
        raise ValueError("地域格式不正确，例如 ap-guangzhou")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", secret_id):
        raise ValueError("SecretId 格式不正确")
    previous = public_config()
    if not secret_key and secret_id != previous["secret_id"]:
        raise ValueError("更换 SecretId 时请同时填写 SecretKey")
    if secret_key:
        if not credential_store.save(_secret_name(), secret_key.strip()):
            raise RuntimeError("系统凭据库不可用，未保存密钥；请启用系统钥匙串后重试")
    elif not previous["credential_available"]:
        raise ValueError("请填写 SecretKey")
    db.set_runtime_setting(_SETTING, json.dumps({"bucket": bucket, "region": region,
                                                 "secret_id": secret_id}, ensure_ascii=False))
    return public_config()


def _client(settings: dict):
    try:
        from qcloud_cos import CosConfig, CosS3Client
    except ImportError as exc:
        raise RuntimeError("当前安装包缺少腾讯云 COS 组件，请更新 MailAI") from exc
    key = credential_store.load(_secret_name())
    if not key:
        raise ValueError("腾讯云 COS 密钥不可用，请重新配置")
    return CosS3Client(CosConfig(Region=settings["region"], SecretId=settings["secret_id"],
                                     SecretKey=key, Scheme="https", Timeout=60))


def _upload_file(path: str, filename: str, size: int, days: int, object_id: str = "") -> dict:
    settings = public_config()
    if not settings["bucket"] or not settings["region"] or not settings["credential_available"]:
        raise ValueError("请先配置腾讯云 COS")
    client = _client(settings)
    safe_name = re.sub(r"[\\/\r\n\x00-\x1f]", "_", filename).strip()[:160] or "共享文件"
    key = f"mailai-shares/{object_id or uuid.uuid4().hex}/{safe_name}"
    client.upload_file(Bucket=settings["bucket"], Key=key, LocalFilePath=path,
                       PartSize=10, MAXThread=2)
    seconds = days * 24 * 60 * 60
    url = client.get_presigned_download_url(Bucket=settings["bucket"], Key=key, Expired=seconds)
    return {"name": safe_name, "url": url, "size": size,
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()}


async def upload_request(request, encoded_filename: str, days: int) -> dict:
    if days not in (1, 3, 7):
        raise ValueError("链接有效期只能是 1、3 或 7 天")
    filename = unquote(encoded_filename or "").strip()
    if not filename or len(filename) > 200:
        raise ValueError("文件名无效")
    if not public_config()["credential_available"]:
        raise ValueError("请先配置腾讯云 COS")
    length = getattr(request, 'headers', {}).get('content-length')
    if length is not None:
        try:
            length = int(length)
        except (TypeError, ValueError) as exc:
            raise ValueError("文件大小无效") from exc
        if length <= 0 or length > _MAX_FILE_BYTES:
            raise ValueError("共享文件大小须在 1 字节到 2 GB 之间")
        if shutil.disk_usage(tempfile.gettempdir()).free < length + 64 * 1024 * 1024:
            raise ValueError("本机临时空间不足，请释放磁盘空间后重试")
    if not _upload_slots.acquire(blocking=False):
        raise UploadBusyError("已有大附件正在上传，请等它完成后再试")
    path = None
    transferred = False
    size = 0
    try:
        fd, path = tempfile.mkstemp(prefix="mailai-share-")
        with os.fdopen(fd, "wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > _MAX_FILE_BYTES:
                    raise ValueError("单个共享文件不能超过 2 GB")
                output.write(chunk)
        if not size:
            raise ValueError("不能上传空文件")
        if length is not None and size != length:
            raise ValueError("文件接收不完整，请重新选择并上传")

        def upload_and_cleanup():
            # Request cancellation does not stop a thread. Let that thread own
            # the temporary file until COS has finished reading it.
            try:
                return _upload_file(path, filename, size, days)
            finally:
                try:
                    os.unlink(path)
                finally:
                    _upload_slots.release()

        task = asyncio.create_task(asyncio.to_thread(upload_and_cleanup))
        _uploads.add(task)
        def finished(done):
            _uploads.discard(done)
            if not done.cancelled():
                done.exception()  # Consume failures even if the caller left.
        task.add_done_callback(finished)
        transferred = True
        return await asyncio.shield(task)
    finally:
        if not transferred:
            try:
                if path is not None:
                    os.unlink(path)
            finally:
                _upload_slots.release()
