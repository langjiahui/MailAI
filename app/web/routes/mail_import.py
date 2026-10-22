"""Local-only exported mail import endpoints (raw, bounded streaming uploads)."""
import hashlib

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ... import mail_import as importer

router = APIRouter()


class ImportRequest(BaseModel):
    label: str = Field(default='Foxmail 导入', max_length=80)
    expected_files: int = Field(ge=1, le=importer.MAX_FILES)
    large_messages: bool = False
    destination: str = Field(default='local_archive', max_length=20)


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
    return call(importer.create, payload.label, payload.expected_files, payload.large_messages, payload.destination)


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
        job = importer.status(token)
        message_limit = importer.MAX_LARGE_MESSAGE_SIZE if job.get('large_messages') else importer.MAX_MESSAGE_SIZE
        limit = message_limit if path.suffix == '.eml' else importer.MAX_SOURCE_SIZE
        with path.open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise ValueError(f'邮件大小至少 {size / 1024**2:.1f} MB，超过当前 {limit // 1024**2} MB 限制')
                output.write(chunk)
                digest.update(chunk)
        result = importer.finish_upload(token, key, name, size, index, digest.hexdigest())
        succeeded = True
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ClientDisconnect as exc:
        raise HTTPException(400, '文件传输中断，已添加的文件已保留，请继续添加') from exc
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
