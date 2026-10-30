"""Local-only exported mail import endpoints (raw, bounded streaming uploads)."""
import asyncio
import hashlib
import logging
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from ... import mail_import as importer

router = APIRouter()
log = logging.getLogger(__name__)
UPLOAD_IDLE_SECONDS = 20


class ImportRequest(BaseModel):
    label: str = Field(default='Foxmail 导入', max_length=80)
    expected_files: int = Field(ge=1, le=importer.MAX_FILES)
    large_messages: bool = False
    destination: str = Field(default='local_archive', max_length=20)
    auto_import: bool = False


class SkipFileRequest(BaseModel):
    index: int = Field(ge=0, lt=importer.MAX_FILES)
    name: str = Field(min_length=1, max_length=4096)
    reason: str = Field(default='', max_length=500)


def call(function, *args):
    try:
        return function(*args)
    except importer.UploadBusy as exc:
        raise HTTPException(409, str(exc), headers={'Retry-After': '1'}) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('/api/mail/client-imports')
def api_mail_import_history():
    return importer.history()


@router.post('/api/mail/client-imports')
def api_mail_import_create(payload: ImportRequest):
    return call(importer.create, payload.label, payload.expected_files, payload.large_messages, payload.destination, payload.auto_import)


@router.get('/api/mail/client-imports/{token}')
def api_mail_import_status(token: str):
    return call(importer.status, token)


@router.get('/api/mail/client-imports/{token}/report')
def api_mail_import_report(token: str):
    try:
        path = call(importer.report, token)
    except OSError as exc:
        raise HTTPException(507, '无法生成清单，请检查磁盘空间后重试') from exc
    return FileResponse(path, filename='MailAI-导入问题清单.csv', media_type='text/csv; charset=utf-8',
                        headers={'Cache-Control': 'no-store'})


async def _disk_io(function, *args):
    # Await the actual disk operation even if the request is canceled. Otherwise
    # cleanup could unlink a file or release its writer while it is still in use.
    started = time.monotonic()
    task = asyncio.create_task(run_in_threadpool(function, *args))
    canceled = False
    try:
        while True:
            try:
                result = await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.cancelled():
                    raise
                # Shutdown can cancel a request again during cleanup. Keep
                # shielding until the worker has actually released the file.
                canceled = True
                continue
            except BaseException:
                if canceled:
                    raise asyncio.CancelledError from None
                raise
            if canceled:
                raise asyncio.CancelledError
            return result
    finally:
        elapsed = time.monotonic() - started
        if elapsed >= 5:
            log.warning('Slow local mail import disk operation: %s (%.1fs)', function.__name__, elapsed)


class _Upload:
    """One bounded streaming writer, with all blocking work off the ASGI loop."""
    def __init__(self, token, name, index):
        self.token, self.name, self.index = token, name, index
        self.key = self.path = self.output = None
        self.size = self.checkpoint = 0
        self.digest = hashlib.sha256()
        self.succeeded = False

    def open(self, declared):
        skipped = call(importer.skipped_upload, self.token, self.index, self.name)
        if skipped is not None:
            return skipped
        self.key, self.path, self.name = call(importer.begin_upload, self.token, self.name, self.index)
        self.limit = importer.MAX_LARGE_MESSAGE_SIZE if self.path.suffix == '.eml' else importer.MAX_SOURCE_SIZE
        job = importer.status(self.token)
        if declared.isdigit():
            if int(declared) > self.limit:
                raise ValueError(f'文件大小超过 {self.limit // 1024**2} MB，请在原客户端分开导出')
            # Reserve the scan copy too; replaying a saved ordinal needs no
            # additional permanent copies beyond the temporary upload.
            replay = self.index is not None and self.index < job['files']
            needed = max(job['bytes'], int(declared)) if replay else job['bytes'] + int(declared) * 2
            importer.ensure_space(self.path.parent, needed)
        self.output = self.path.open('wb')

    def write(self, chunk):
        self.size += len(chunk)
        if self.size > self.limit:
            raise ValueError(f'邮件大小至少 {self.size / 1024**2:.1f} MB，超过当前 {self.limit // 1024**2} MB 限制')
        if self.size >= self.checkpoint:
            importer.ensure_space(self.path.parent, len(chunk))
            self.checkpoint = self.size + 4 * 1024**2
        self.output.write(chunk)
        self.digest.update(chunk)

    def finish(self):
        output, self.output = self.output, None
        output.close()
        result = importer.finish_upload(self.token, self.key, self.name, self.size, self.index, self.digest.hexdigest())
        self.succeeded = True
        return result

    def close(self):
        try:
            if self.output is not None:
                output, self.output = self.output, None
                output.close()
        finally:
            if self.key is not None:
                try:
                    if not self.succeeded:
                        self.path.unlink(missing_ok=True)
                finally:
                    importer.end_upload(self.token)


@router.put('/api/mail/client-imports/{token}/files')
async def api_mail_import_upload(token: str, request: Request, name: str, index: int | None = None):
    upload = _Upload(token, name, index)
    try:
        declared = request.headers.get('content-length', '') if hasattr(request, 'headers') else ''
        skipped = await _disk_io(upload.open, declared)
        if skipped is not None:
            return skipped
        stream = request.stream().__aiter__()
        while True:
            try:
                chunk = await asyncio.wait_for(anext(stream), timeout=UPLOAD_IDLE_SECONDS)
            except StopAsyncIteration:
                break
            await _disk_io(upload.write, chunk)
        return await _disk_io(upload.finish)
    except importer.UploadMismatch as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ClientDisconnect as exc:
        log.warning('Local mail upload disconnected: index=%s bytes=%s', index, upload.size)
        raise HTTPException(408, '文件传输中断，已添加的文件已保留，请继续添加') from exc
    except TimeoutError as exc:
        log.warning('Local mail upload idle timeout: index=%s bytes=%s', index, upload.size)
        raise HTTPException(408, '文件传输长时间没有进展，已保存的文件会保留，请继续添加。') from exc
    except OSError as exc:
        log.warning('Local mail upload disk error: index=%s bytes=%s errno=%s', index, upload.size, exc.errno)
        raise HTTPException(507, importer.file_error(exc)) from exc
    finally:
        await _disk_io(upload.close)


@router.post('/api/mail/client-imports/{token}/skip-file')
def api_mail_import_skip_file(token: str, payload: SkipFileRequest):
    try:
        return call(importer.skip_upload, token, payload.index, payload.name, payload.reason)
    except OSError as exc:
        raise HTTPException(507, '无法保存跳过记录，请检查磁盘空间后重试') from exc


@router.post('/api/mail/client-imports/{token}/scan')
def api_mail_import_scan(token: str):
    return call(importer.start, token, 'scan')


@router.post('/api/mail/client-imports/{token}/apply')
def api_mail_import_apply(token: str):
    return call(importer.start, token, 'import')


@router.post('/api/mail/client-imports/{token}/pause')
def api_mail_import_pause(token: str):
    return call(importer.pause, token)


@router.delete('/api/mail/client-imports/{token}')
def api_mail_import_discard(token: str):
    return call(importer.discard, token)


@router.get('/api/mail/client-imports/{token}/retry-files')
def api_mail_import_retry_files(token: str):
    return call(importer.retry_files, token)


@router.get('/api/mail/client-imports/{token}/issues')
def api_mail_import_issues(token: str, offset: int = 0, limit: int = 30):
    return call(importer.issues, token, max(0, offset), max(1, min(limit, 100)))


@router.post('/api/mail/client-imports/{token}/organize')
def api_mail_import_organize(token: str):
    return call(importer.organize, token)
