"""Local-only exported mail import endpoints (raw, bounded streaming uploads)."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from ... import mail_import as importer

router = APIRouter()


class ImportRequest(BaseModel):
    label: str = Field(default='Foxmail 导入', max_length=80)
    expected_files: int = Field(ge=1, le=importer.MAX_FILES)


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
    return call(importer.create, payload.label, payload.expected_files)


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
async def api_mail_import_upload(token: str, request: Request, name: str):
    key, path, name = call(importer.begin_upload, token, name)
    succeeded = False
    try:
        size = 0
        limit = importer.MAX_MESSAGE_SIZE if path.suffix == '.eml' else importer.MAX_SOURCE_SIZE
        with path.open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise ValueError('单封邮件超过 64 MB，请在 Foxmail 中单独检查' if path.suffix == '.eml' else '单个文件超过 1 GB，请在 Foxmail 中分批导出')
                output.write(chunk)
        result = importer.finish_upload(token, key, name, size)
        succeeded = True
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ClientDisconnect as exc:
        raise HTTPException(400, '文件添加已停止，请重新选择整批文件') from exc
    except OSError as exc:
        raise HTTPException(507, '文件暂存失败，请检查磁盘空间和文件访问权限') from exc
    finally:
        if not succeeded:
            path.unlink(missing_ok=True)
        importer.end_upload(token)


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
