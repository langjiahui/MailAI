"""系统设置：账号、更新、备份迁移、模型配置、诊断与个人偏好。"""
import json
import logging
import os
import sqlite3

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

from ... import config, db, mail_assistant, mail_providers, pipeline, release_update, system_settings
from ...account_guard import start_account_thread
from ..helpers import (annotate_list_identity, complete_mailbox_initialization,
                       mail_connection_detail)
from ..schemas import (AccountSwitchRequest, CleanupExecuteRequest, CleanupPreviewRequest,
                       MailAccountUpdateRequest, MailLoginRequest, MailLogoutRequest,
                       ModelConfigRequest, PortableExportRequest, PortableImportRequest,
                       PreferencesRequest)

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/system/config")
def api_system_config():
    return system_settings.public_config()


@router.get("/api/system/update")
def api_system_update(force: bool = False):
    try:
        return release_update.check(force=force)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.warning("检查更新失败: %s", str(exc)[:200])
        raise HTTPException(502, f"检查更新失败：{exc}")


@router.post("/api/system/update/install")
def api_system_update_install():
    try:
        return release_update.start_install()
    except (OSError, ValueError) as exc:
        log.warning("启动更新失败: %s", str(exc)[:200])
        raise HTTPException(409, f"更新失败：{exc}")


@router.get("/api/system/update/install/status")
def api_system_update_install_status():
    return release_update.install_status()


@router.get("/api/system/mail/discover")
def api_mail_discover(email: str = ""):
    return mail_providers.discover(email)


@router.post("/api/system/mail/login")
def api_mail_login(payload: MailLoginRequest):
    if pipeline.is_fetch_running():
        raise HTTPException(409, "邮件正在同步，请等待同步完成后再切换账号")
    if not payload.host.strip() or not payload.smtp_host.strip() or not payload.user.strip() or not payload.password:
        raise HTTPException(400, "请填写完整的收件服务器、发件服务器、邮箱账号和授权码")
    try:
        result = system_settings.login_mail(payload.model_dump())
    except Exception as exc:
        log.warning("邮箱登录失败: %s: %s", type(exc).__name__, str(exc)[:160])
        raise HTTPException(400, mail_connection_detail(exc))
    # 新账号首次登录后自动在后台完成全量初始化；旧账号只增量同步。
    def _initialize_mailbox():
        try:
            pipeline.repair_local_mail_data()
            if result.get("initialization_needed"):
                complete_mailbox_initialization()
            else:
                pipeline.poll_once()
        except Exception:
            log.exception("邮箱后台初始化失败")
    start_account_thread(_initialize_mailbox, name="mailai-bootstrap")
    return {"ok": True, **result, "initialization_started": True,
            "config": system_settings.public_config()}


@router.post("/api/system/mail/logout")
def api_mail_logout(payload: MailLogoutRequest):
    from ...account_context import any_busy
    if any_busy():
        raise HTTPException(409, '邮箱任务仍在执行，请完成后再移除账号')
    if pipeline.is_fetch_running():
        raise HTTPException(409, "邮件正在同步，请等待同步完成后再退出账号")
    try:
        result = system_settings.logout_mail(clear_history=payload.clear_history,
                                             account_id=payload.account_id)
    except KeyError:
        raise HTTPException(404, "邮箱账号不存在或已经退出")
    return {**result, "config": system_settings.public_config()}


@router.post("/api/system/mail/switch")
def api_mail_switch(payload: AccountSwitchRequest):
    try:
        result = system_settings.switch_mail_account(payload.account_id)
    except KeyError:
        raise HTTPException(404, "邮箱账号不存在")
    except Exception as exc:
        log.warning("切换邮箱失败: %s", type(exc).__name__)
        raise HTTPException(400, str(exc) or "邮箱切换失败，请重新登录")
    from ...mailbox_jobs import poll_all
    poll_all()
    return {**result, "config": system_settings.public_config()}


@router.post('/api/system/mail/preferred')
def api_mail_preferred(payload: AccountSwitchRequest):
    """Remember the account selected in the UI without interrupting scoped work."""
    try:
        return system_settings.remember_mail_account(payload.account_id)
    except KeyError:
        raise HTTPException(404, '邮箱账号不存在')
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@router.post("/api/system/mail/account/update")
def api_mail_account_update(payload: MailAccountUpdateRequest):
    if pipeline.is_fetch_running():
        raise HTTPException(409, "邮件正在同步，请等待同步完成后再更新账号")
    try:
        result = system_settings.update_mail_account(payload.account_id, payload.model_dump())
    except KeyError:
        raise HTTPException(404, "邮箱账号不存在")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except system_settings.MailConnectionError as exc:
        log.warning("更新邮箱账号连接验证失败: %s (%s)", exc.stage, type(exc.cause).__name__)
        raise HTTPException(400, mail_connection_detail(exc))
    except Exception as exc:
        log.warning("更新邮箱账号失败: %s", type(exc).__name__)
        raise HTTPException(400, "账号更新失败，请稍后重试")
    return {**result, "config": system_settings.public_config()}


@router.get("/api/system/mail/unified-inbox")
def api_unified_inbox(days: int = 9999, limit: int = 1000, offset: int = 0, q: str = ''):
    emails = system_settings.list_unified_inbox(days=days, limit=limit, offset=offset, q=q)
    for email in emails:
        annotate_list_identity(email, email.pop("_contact_names", {}))
        email.pop("body_text", None)
        email.pop("body_html", None)
    return emails


@router.post('/api/system/server-cleanup/preview')
def api_cleanup_preview(payload: CleanupPreviewRequest):
    from ... import server_cleanup
    try:
        return server_cleanup.preview(payload.folder, payload.before_date, payload.include_favorites, payload.offset)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(502, f'预览失败：{exc}')


@router.post('/api/system/server-cleanup/execute')
def api_cleanup_execute(payload: CleanupExecuteRequest):
    from ... import server_cleanup
    if not pipeline._poll_lock.acquire(blocking=False):
        raise HTTPException(409, '邮件正在同步，请等待同步完成后重新预览')
    try:
        return server_cleanup.execute(payload.token, payload.confirmation, payload.acknowledge)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    finally:
        pipeline._poll_lock.release()


@router.get('/api/system/server-cleanup/history')
def api_cleanup_history():
    from ... import server_cleanup
    return server_cleanup.history()


@router.get("/api/system/backups")
def api_backups():
    return system_settings.list_backups()


@router.post("/api/system/portable-backups")
def api_create_portable_backup(payload: PortableExportRequest):
    from ... import portable_backup
    try:
        return portable_backup.create(include_raw=payload.include_raw, password=payload.password,
                                      since=payload.since, until=payload.until)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        raise HTTPException(400, str(exc))


@router.get("/api/system/portable-backups")
def api_portable_backups():
    from ... import portable_backup
    return portable_backup.list_stored()


@router.get("/api/system/portable-backups/download/{filename}")
def api_download_portable_backup(filename: str):
    from ... import portable_backup
    try:
        return FileResponse(portable_backup.stored_path(filename), filename=filename,
                            media_type="application/octet-stream")
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))


@router.delete("/api/system/portable-backups/stored/{filename}")
def api_delete_portable_backup(filename: str):
    from ... import portable_backup
    try:
        return portable_backup.delete_stored(filename)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))
    except OSError as exc:
        raise HTTPException(409, f"无法删除迁移包：{exc}")


@router.post("/api/system/portable-backups/inspect")
async def api_inspect_portable_backup(request: Request, x_migration_password: str = Header(default="", max_length=1024)):
    from ... import portable_backup
    import tempfile
    upload_dir = os.path.join(config.DATA_DIR, "imports")
    os.makedirs(upload_dir, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".upload-", dir=upload_dir)
    try:
        size = 0
        with os.fdopen(descriptor, "wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > portable_backup.MAX_ARCHIVE_SIZE:
                    raise ValueError("迁移包超过支持的大小")
                output.write(chunk)
        if not size:
            raise ValueError("迁移包为空")
        return portable_backup.stage_file(temporary, password=x_migration_password)
    except (ValueError, RuntimeError, OSError, sqlite3.Error, json.JSONDecodeError) as exc:
        raise HTTPException(400, str(exc))
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass


@router.post("/api/system/portable-backups/restore")
def api_restore_portable_backup(payload: PortableImportRequest):
    from ... import portable_backup
    if not pipeline._poll_lock.acquire(blocking=False):
        raise HTTPException(409, "邮件正在同步，请等待同步完成后导入")
    try:
        return portable_backup.restore_staged(payload.import_token, password=payload.password)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        raise HTTPException(400, str(exc))
    finally:
        pipeline._poll_lock.release()


@router.delete("/api/system/portable-backups/import/{token}")
def api_discard_portable_backup(token: str):
    from ... import portable_backup
    try:
        return portable_backup.discard_staged(token)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))


@router.post("/api/system/backups")
def api_create_backup(include_raw: bool = True):
    try:
        return system_settings.create_backup(include_raw)
    except Exception as exc:
        log.exception("创建备份失败")
        raise HTTPException(500, f"创建备份失败: {exc}")


@router.get("/api/system/backups/{filename}")
def api_download_backup(filename: str):
    try:
        return FileResponse(system_settings.backup_path(filename), filename=filename,
                            media_type="application/zip")
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "备份文件不存在")


@router.delete("/api/system/backups/{filename}")
def api_delete_backup(filename: str):
    try:
        return system_settings.delete_backup(filename)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "备份文件不存在")
    except OSError as exc:
        raise HTTPException(409, f"无法删除备份：{exc}")


@router.post("/api/system/backups/{filename}/restore")
def api_restore_backup(filename: str, start_date: str = "", end_date: str = ""):
    if not pipeline._poll_lock.acquire(blocking=False):
        raise HTTPException(409, "邮件正在同步，请等待同步结束后恢复备份")
    try:
        return system_settings.restore_backup(filename, start_date=start_date, end_date=end_date)
    except FileNotFoundError:
        raise HTTPException(404, "备份文件不存在")
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        log.exception("恢复备份失败")
        raise HTTPException(500, f"恢复备份失败: {exc}")
    finally:
        pipeline._poll_lock.release()


@router.post("/api/system/model")
def api_model_config(payload: ModelConfigRequest):
    switching = payload.model_fields_set == {'provider'}
    if not switching and (not payload.base_url.strip() or not payload.model.strip()):
        raise HTTPException(400, "请填写 API 地址和模型名称")
    try:
        system_settings.save_model(payload.model_dump(include={'provider'}) if switching else payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"ok": True, "config": system_settings.public_config()}


@router.post("/api/system/model/test")
def api_model_test(payload: ModelConfigRequest | None = None):
    return system_settings.test_model(payload.model_dump() if payload else None)


@router.get("/api/system/diagnostics")
def api_system_diagnostics(lang: str = "zh"):
    # 界面语言来自前端偏好；只允许已知语言码，避免反射进文案
    return system_settings.diagnostics(lang=lang if lang in ("zh", "en") else "zh")


@router.get('/api/preferences')
def api_preferences():
    return mail_assistant.preferences()


@router.put('/api/preferences')
def api_save_preferences(payload: PreferencesRequest):
    if payload.notifications not in ('all', 'important', 'high_risk', 'off'):
        raise HTTPException(400, '通知选项无效')
    db.set_runtime_setting('user_preferences', json.dumps(payload.model_dump()))
    return payload.model_dump()
