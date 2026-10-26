"""Local-only exported mail import endpoints (raw, bounded streaming uploads)."""
import asyncio
import hashlib

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ... import mail_import as importer

router = APIRouter()
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


@router.put('/api/mail/client-imports/{token}/files')
async def api_mail_import_upload(token: str, request: Request, name: str, index: int | None = None):
    skipped = call(importer.skipped_upload, token, index, name)
    if skipped is not None:
        return skipped
    key, path, name = call(importer.begin_upload, token, name, index)
    succeeded = False
    try:
        size = 0
        digest = hashlib.sha256()
        limit = importer.MAX_LARGE_MESSAGE_SIZE if path.suffix == '.eml' else importer.MAX_SOURCE_SIZE
        job = importer.status(token)
        declared = request.headers.get('content-length', '') if hasattr(request, 'headers') else ''
        if declared.isdigit():
            if int(declared) > limit:
                raise ValueError(f'文件大小超过 {limit // 1024**2} MB，请在原客户端分开导出')
            # Reserve a scan copy for all collected sources. Upload copies are
            # released before final originals are saved, keeping peak use down.
            replay = index is not None and index < job['files']
            needed = max(job['bytes'], int(declared)) if replay else job['bytes'] + int(declared) * 2
            importer.ensure_space(path.parent, needed)
        checkpoint = 0
        with path.open('wb') as output:
            stream = request.stream().__aiter__()
            while True:
                try:
                    chunk = await asyncio.wait_for(anext(stream), timeout=UPLOAD_IDLE_SECONDS)
                except StopAsyncIteration:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError(f'邮件大小至少 {size / 1024**2:.1f} MB，超过当前 {limit // 1024**2} MB 限制')
                if size >= checkpoint:
                    importer.ensure_space(path.parent, len(chunk))
                    checkpoint = size + 4 * 1024**2
                output.write(chunk)
                digest.update(chunk)
        result = importer.finish_upload(token, key, name, size, index, digest.hexdigest())
        succeeded = True
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ClientDisconnect as exc:
        raise HTTPException(408, '文件传输中断，已添加的文件已保留，请继续添加') from exc
    except TimeoutError as exc:
        raise HTTPException(408, '文件传输长时间没有进展，已保存的文件会保留，请继续添加。') from exc
    except OSError as exc:
        raise HTTPException(507, importer.file_error(exc)) from exc
    finally:
        if not succeeded:
            path.unlink(missing_ok=True)
        importer.end_upload(token)


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
