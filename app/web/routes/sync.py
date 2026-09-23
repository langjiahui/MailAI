"""邮件同步：文件夹管理与拉取任务控制。"""
import logging

from fastapi import APIRouter, HTTPException

from ... import config, pipeline
from ...account_guard import start_account_thread
from ..helpers import complete_mailbox_initialization, current_server
from ..schemas import FolderRequest

log = logging.getLogger(__name__)
router = APIRouter()


@router.post('/api/mail/auto-sync')
def api_auto_sync(paused: bool):
    """Persist the current account's background-poll preference."""
    from ... import system_settings
    account_id = getattr(config, 'ACCOUNT_ID', '')
    registry = system_settings._load_registry()
    account = registry.get('accounts', {}).get(account_id)
    if account is None:
        raise HTTPException(404, '邮箱账号不存在')
    account['auto_sync_paused'] = paused
    system_settings._save_registry(registry)
    if paused:
        pipeline.cancel_fetch()
    else:
        from ...mailbox_jobs import poll_all
        poll_all(force=True, account_id=account_id)
    return {'ok': True, 'paused': paused}


@router.get("/api/mail/folders")
def api_mail_folders():
    try:
        with current_server().MailClient() as mail:
            return mail.list_mailboxes()
    except Exception as exc:
        log.exception("读取邮件文件夹失败")
        raise HTTPException(502, f"读取邮件文件夹失败: {exc}")


@router.post("/api/mail/folders/sync")
def api_sync_mail_folder(folder: str, limit: int = 0):
    folder = folder.strip()
    if not folder:
        raise HTTPException(400, "文件夹不能为空")
    if limit < 0:
        raise HTTPException(400, "同步数量不能为负数")
    try:
        result = pipeline.sync_mail_folder(folder, limit)
        if not result.get("ok"):
            raise HTTPException(409, result.get("msg") or "同步任务正在运行")
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        log.exception("同步文件夹失败")
        raise HTTPException(502, f"同步文件夹失败: {exc}")


@router.post("/api/mail/folders")
def api_create_mail_folder(payload: FolderRequest):
    name = payload.name.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "文件夹名称无效")
    try:
        with current_server().MailClient() as mail:
            mail.create_mailbox(name)
        return {"ok": True, "name": name}
    except Exception as exc:
        raise HTTPException(502, f"创建文件夹失败: {exc}")


@router.delete("/api/mail/folders")
def api_delete_mail_folder(name: str):
    protected = {config.INBOX_FOLDER, config.QUARANTINE_FOLDER, config.SPAM_FOLDER}
    if name in protected:
        raise HTTPException(400, "系统文件夹不能删除")
    try:
        with current_server().MailClient() as mail:
            mail.delete_mailbox(name)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"删除文件夹失败: {exc}")


@router.post("/api/poll")
def api_poll():
    from ...mailbox_jobs import poll_all
    busy = pipeline.get_live_fetch_state()['running']
    result = poll_all(force=True, account_id=getattr(config, 'ACCOUNT_ID', '') or None)
    if not result.get('ok') and not busy:
        raise HTTPException(400, result.get('msg') or '暂时无法同步邮箱')
    busy = busy or result.get('queued', False)
    return {"ok": True, "queued": busy, "msg": "当前同步仍在进行，已安排检查新邮件" if busy else "已开始拉取"}


@router.post("/api/fetch_more")
def api_fetch_more(limit: int = 20):
    def _run():
        try:
            pipeline.fetch_more(limit=limit)
        except Exception:
            log.exception("拉取更多历史邮件失败")
    start_account_thread(_run, name="mailai-fetch-more")
    return {"ok": True, "msg": "已开始拉取更多历史邮件"}


@router.post("/api/fetch_all")
def api_fetch_all():
    def _run():
        try:
            complete_mailbox_initialization()
        except Exception:
            log.exception("拉取全部历史邮件失败")
    start_account_thread(_run, name="mailai-fetch-all")
    return {"ok": True, "msg": "已开始完整同步收件箱、已发送、草稿和自定义文件夹，请稍后刷新"}


@router.get("/api/fetch_status")
def api_fetch_status():
    return pipeline.get_fetch_state()


@router.post("/api/cancel_fetch")
def api_cancel_fetch():
    pipeline.cancel_fetch()
    return {"ok": True, "msg": "已请求取消拉取"}
