"""FastAPI 接口：邮件列表、待办、隔离区操作、日报。"""
import logging
import os
import json
import re
import sqlite3
import threading
from datetime import datetime
from email.utils import getaddresses

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .. import config, db, pipeline, profiles, threads, system_settings, smtp_client, mail_assistant, mail_providers, parser as mail_parser, signatures, outgoing_guard, release_update
from ..imap_client import MailClient, mailbox_role
from ..account_guard import AccountGuardMiddleware, start_account_thread
from ..reply_recipients import recipients as reply_recipients
from ..parser import extract_attachment, extract_inline_resource, extract_rich_body
from ..security import campaigns, evidence, policy
from ..llm import client as llm_client
from .origin_guard import LocalOriginMiddleware

log = logging.getLogger(__name__)

app = FastAPI(title="MailAI", docs_url=None, redoc_url=None)
app.add_middleware(AccountGuardMiddleware)
app.add_middleware(LocalOriginMiddleware)
_STATIC = os.path.join(os.path.dirname(__file__), "static")

app.mount("/static", StaticFiles(directory=_STATIC), name="static")

_campaign_cache_lock = threading.Lock()
_campaign_cache: dict[tuple[str, int], list[dict]] = {}


def _campaign_groups(days: int = 30) -> list[dict]:
    """按邮箱修订号缓存聚类结果，避免每次打开详情都重复做两两比对。"""
    bounded_days = max(1, min(int(days or 30), 90))
    revision = db.mailbox_revision()["revision"]
    key = (config.DB_PATH, revision, bounded_days)
    with _campaign_cache_lock:
        cached = _campaign_cache.get(key)
    if cached is not None:
        return cached
    result = campaigns.cluster(db.list_emails(days=bounded_days, limit=600))
    with _campaign_cache_lock:
        for old_key in list(_campaign_cache):
            if old_key[0] == config.DB_PATH and old_key[1] != revision:
                _campaign_cache.pop(old_key, None)
        _campaign_cache[key] = result
    return result


@app.on_event("startup")
def startup_init():
    db.init_db()
    system_settings.initialize_current_account()
    job = db.get_sync_job()
    if config.IMAP_USER and config.IMAP_PASSWORD:
        start_account_thread(pipeline.repair_local_mail_data,
                             name="mailai-repair-local-data")
        if job and job.get("status") in ("running", "pending", "failed"):
            start_account_thread(_complete_mailbox_initialization, name="mailai-resume-sync")


def _complete_mailbox_initialization():
    inbox = pipeline.fetch_all(continue_with_folders=True)
    if not inbox.get("canceled"):
        pipeline.sync_auxiliary_folders(preserve_cancel=True)


class MailLoginRequest(BaseModel):
    host: str
    port: int = 993
    user: str
    password: str
    ssl: bool = True
    verify_ssl: bool = True
    smtp_host: str
    smtp_port: int = 465
    smtp_ssl: bool = True
    smtp_starttls: bool = False
    smtp_verify_ssl: bool = True


class AccountSwitchRequest(BaseModel):
    account_id: str


class MailAccountUpdateRequest(MailLoginRequest):
    account_id: str


class MailLogoutRequest(BaseModel):
    clear_history: bool = False
    account_id: str = ""


class FolderRequest(BaseModel):
    name: str


class BulkMailRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    action: str
    value: bool | None = None
    target: str = ""


class AllowlistRequest(BaseModel):
    domain: str
    kind: str = "domain"
    enabled: bool = True
    note: str = ""


class RuleCategoryRequest(BaseModel):
    enabled: bool = True
    sensitivity: str = "balanced"


class ComposeAssistRequest(BaseModel):
    operation: str
    subject: str = ""
    body_text: str = ""
    original_text: str = ""
    user_instruction: str = ""
    recipients: str = ""
    attachment_names: list[str] = Field(default_factory=list)
    tone: str = "正式"
    length: str = "适中"


class ContactRequest(BaseModel):
    email: str
    name: str = ""
    company: str = ""
    note: str = ""
    favorite: bool = False
    group_name: str = ''


class ContactFavoriteRequest(BaseModel):
    email: str
    favorite: bool = True


class SignatureRequest(BaseModel):
    id: str = ""
    name: str = "我的签名"
    html: str = ""
    profile: dict = Field(default_factory=dict)
    make_default: bool = False


class SignatureGenerateRequest(BaseModel):
    profile: dict = Field(default_factory=dict)
    style: str = "专业简洁"


class MailPreflightRequest(BaseModel):
    to_addr: str = ""
    cc_addr: str = ""
    bcc_addr: str = ""
    subject: str = ""
    body_text: str = ""
    attachment_count: int = 0
    attachment_names: list[str] = Field(default_factory=list)
    mode: str = "compose"
    reply_to_email_id: int | None = None
    original_text: str = ""


class TodoUpdateRequest(BaseModel):
    title: str | None = None
    deadline: str | None = None
    stage: str | None = None
    kind: str | None = None
    remind_at: str | None = None


class TodoBulkStatusRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)
    status: str = "done"


class ModelConfigRequest(BaseModel):
    provider: str = "custom"
    extra_params: dict | None = None
    multimodal_enabled: bool = True
    base_url: str = ""
    model: str = ""
    multimodal_model: str = ""
    api_key: str = ""
    verify_ssl: bool = True


class DraftRequest(BaseModel):
    source_draft_email_id: int | None = None
    id: int | None = None
    to_addr: str = ""
    cc_addr: str = ""
    bcc_addr: str = ""
    subject: str = ""
    body_html: str = ""
    attachments: list[dict] = Field(default_factory=list)
    reply_to_email_id: int | None = None
    mode: str = "compose"
    in_reply_to: str = ""
    references: str = ""


class SendMailRequest(DraftRequest):
    in_reply_to: str = ""
    references: str = ""
    preflight_confirmed: bool = False


class QueuedMailRequest(SendMailRequest):
    request_token: str


@app.post('/api/mail/outbox')
def api_queue_mail(payload: QueuedMailRequest):
    from ..outbox import enqueue
    data = payload.model_dump(exclude={'request_token'})
    try:
        return enqueue(payload.request_token, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get('/api/mail/outbox')
def api_outbox():
    from ..outbox import items
    return items()


@app.post('/api/mail/outbox/{token}/cancel')
def api_cancel_outbox(token: str):
    from ..outbox import cancel
    try:
        return cancel(token)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.post('/api/mail/outbox/{token}/resolve')
def api_resolve_outbox(token: str, delivered: bool):
    from ..outbox import resolve
    try:
        return resolve(token, delivered)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


class AssistantImage(BaseModel):
    data_url: str = Field(max_length=7 * 1024 * 1024)


class AssistantAttachmentRef(BaseModel):
    email_id: int = Field(ge=1)
    index: int = Field(ge=0)
    digest: str = Field(pattern=r'^[a-f0-9]{64}$')


class AssistantRequest(BaseModel):
    question: str = Field(max_length=12000)
    history: list[dict] = Field(default_factory=list)
    conversation_id: int | None = None
    email_ids: list[int] | None = None
    scope_label: str = ''
    images: list[AssistantImage] = Field(default_factory=list, max_length=3)
    attachments: list[AssistantAttachmentRef] = Field(default_factory=list, max_length=3)


def _prepare_assistant_images(payload):
    from .. import assistant_vision
    try:
        images = assistant_vision.prepare([item.model_dump() for item in payload.images])
        if images and not assistant_vision.client.available():
            raise ValueError('尚未配置可用模型，图片未发送。请先检查模型连接。')
        if images and not payload.question.strip():
            payload.question = '请提炼这些图片的重点，区分明确事实、待确认信息和建议下一步。'
        return images
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _prepare_assistant_materials(payload, images):
    from .. import assistant_attachments, assistant_vision
    try:
        materials = assistant_attachments.prepare([item.model_dump() for item in payload.attachments])
        if materials and not assistant_vision.client.available():
            raise ValueError('尚未配置可用模型，附件未发送。请先检查模型连接。')
        if len(images)+sum(bool(item.get('image')) for item in materials)>3:
            raise ValueError('上传图片与图片附件合计最多 3 张，请分批分析')
        if materials:
            payload.email_ids = list(dict.fromkeys([m['email_id'] for m in materials]+(payload.email_ids or [])))[:20]
            if not payload.question.strip():
                payload.question = '请结合所选附件与邮件正文，总结重点、差异和待确认事项，并说明提取范围。'
        return materials
    except ValueError as exc:
        raise HTTPException(400,str(exc))


@app.get('/api/emails/{email_id}/assistant-attachments')
def api_assistant_attachment_catalog(email_id:int):
    from .. import assistant_attachments
    try:return assistant_attachments.catalog(email_id)
    except ValueError as exc:raise HTTPException(400,str(exc))


@app.get('/api/emails/{email_id}/assistant-attachments/{index}')
def api_assistant_attachment_preview(email_id:int,index:int):
    from .. import assistant_attachments
    try:
        item=assistant_attachments.extract(email_id,index)
        item['text']=item['text'][:2200]
        return JSONResponse(item, headers={'Cache-Control':'no-store'})
    except ValueError as exc:raise HTTPException(400,str(exc))


class PreferencesRequest(BaseModel):
    notifications: str = 'all'
    muted_threads: list[str] = Field(default_factory=list)


@app.get('/api/preferences')
def api_preferences():
    return mail_assistant.preferences()


@app.put('/api/preferences')
def api_save_preferences(payload: PreferencesRequest):
    if payload.notifications not in ('all', 'important', 'high_risk', 'off'):
        raise HTTPException(400, '通知选项无效')
    db.set_runtime_setting('user_preferences', json.dumps(payload.model_dump()))
    return payload.model_dump()


@app.get("/")
def index():
    # 页面结构与脚本必须同版本，避免升级后浏览器复用旧 HTML 导致新增控件缺失。
    return FileResponse(os.path.join(_STATIC, "index.html"), headers={"Cache-Control": "no-store"})


@app.get("/api/stats")
def api_stats(days: int = 7):
    """兼容旧接口，返回扩展指标。"""
    return db.stats_range(days)


@app.get("/api/dashboard")
def api_dashboard(days: int = 7):
    stats = db.stats_range(days)
    operations = db.dashboard_operations(days)
    evaluation = None
    report_path = os.path.join(config.DATA_DIR, "evaluation_latest.json")
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            evaluation = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    return {
        **stats,
        "trend": db.daily_trend(days),
        "top_senders": db.sender_risk_top(5),
        "todos_open": db.list_todos(include_done=False).__len__(),
        "evaluation": evaluation,
        "operations": operations,
        "action_policy": pipeline.get_action_policy(),
        "campaigns": _campaign_groups(days),
    }


@app.get("/api/security/campaigns")
def api_security_campaigns(days: int = 30):
    return {"items": _campaign_groups(days), "days": max(1, min(days, 90))}


@app.get("/api/action_policy")
def api_action_policy():
    return pipeline.get_action_policy()


@app.post("/api/action_policy")
def api_set_action_policy(mode: str):
    try:
        return pipeline.set_action_mode(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/system/config")
def api_system_config():
    return system_settings.public_config()


@app.get("/api/system/update")
def api_system_update(force: bool = False):
    try:
        return release_update.check(force=force)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.warning("检查更新失败: %s", str(exc)[:200])
        raise HTTPException(502, f"检查更新失败：{exc}")


@app.post("/api/system/update/install")
def api_system_update_install():
    try:
        return release_update.start_install()
    except (OSError, ValueError) as exc:
        log.warning("启动更新失败: %s", str(exc)[:200])
        raise HTTPException(409, f"更新失败：{exc}")


@app.get("/api/system/update/install/status")
def api_system_update_install_status():
    return release_update.install_status()


@app.get("/api/system/mail/discover")
def api_mail_discover(email: str = ""):
    return mail_providers.discover(email)


@app.post("/api/system/mail/login")
def api_mail_login(payload: MailLoginRequest):
    if pipeline.is_fetch_running():
        raise HTTPException(409, "邮件正在同步，请等待同步完成后再切换账号")
    if not payload.host.strip() or not payload.smtp_host.strip() or not payload.user.strip() or not payload.password:
        raise HTTPException(400, "请填写完整的收件服务器、发件服务器、邮箱账号和授权码")
    try:
        result = system_settings.login_mail(payload.model_dump())
    except Exception as exc:
        log.warning("邮箱登录失败: %s: %s", type(exc).__name__, str(exc)[:160])
        root = exc.cause if isinstance(exc, system_settings.MailConnectionError) else exc
        stage = "发件（SMTP）" if getattr(exc, "stage", "") == "smtp" else "收件（IMAP）"
        name = type(root).__name__
        message = str(root).lower()
        if "authentication" in message or "login" in message or "535" in message:
            detail = f"{stage}账号或授权码验证失败。请确认邮箱已开启 IMAP/SMTP，并使用客户端授权码而不是网页登录密码。"
        elif "certificate" in message or "ssl" in message:
            detail = f"{stage}SSL 证书校验失败。请确认服务器地址正确；仅在企业内网使用自签名证书时关闭证书校验。"
        elif "timed out" in message or "timeout" in message:
            detail = f"{stage}连接超时。请检查网络、VPN、防火墙及服务器端口。"
        elif name in ("gaierror", "ConnectionRefusedError", "ConnectionError", "OSError"):
            detail = f"无法连接{stage}服务器。请检查服务器地址、端口、网络或 VPN。"
        else:
            detail = f"{stage}验证失败。请展开高级设置检查服务器参数。"
        raise HTTPException(400, detail)
    # 新账号首次登录后自动在后台完成全量初始化；旧账号只增量同步。
    def _initialize_mailbox():
        try:
            pipeline.repair_local_mail_data()
            if result.get("initialization_needed"):
                _complete_mailbox_initialization()
            else:
                pipeline.poll_once()
        except Exception:
            log.exception("邮箱后台初始化失败")
    start_account_thread(_initialize_mailbox, name="mailai-bootstrap")
    return {"ok": True, **result, "initialization_started": True,
            "config": system_settings.public_config()}


@app.post("/api/system/mail/logout")
def api_mail_logout(payload: MailLogoutRequest):
    from ..account_context import any_busy
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


@app.post("/api/system/mail/switch")
def api_mail_switch(payload: AccountSwitchRequest):
    try:
        result = system_settings.switch_mail_account(payload.account_id)
    except KeyError:
        raise HTTPException(404, "邮箱账号不存在")
    except Exception as exc:
        log.warning("切换邮箱失败: %s", type(exc).__name__)
        raise HTTPException(400, str(exc) or "邮箱切换失败，请重新登录")
    from ..mailbox_jobs import poll_all
    poll_all()
    return {**result, "config": system_settings.public_config()}


@app.post('/api/system/mail/preferred')
def api_mail_preferred(payload: AccountSwitchRequest):
    """Remember the account selected in the UI without interrupting scoped work."""
    try:
        return system_settings.remember_mail_account(payload.account_id)
    except KeyError:
        raise HTTPException(404, '邮箱账号不存在')
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/system/mail/account/update")
def api_mail_account_update(payload: MailAccountUpdateRequest):
    if pipeline.is_fetch_running():
        raise HTTPException(409, "邮件正在同步，请等待同步完成后再更新账号")
    try:
        result = system_settings.update_mail_account(payload.account_id, payload.model_dump())
    except KeyError:
        raise HTTPException(404, "邮箱账号不存在")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        log.warning("更新邮箱账号失败: %s", type(exc).__name__)
        raise HTTPException(400, "账号验证失败，请检查授权码和服务器设置")
    return {**result, "config": system_settings.public_config()}


@app.get("/api/system/mail/unified-inbox")
def api_unified_inbox(days: int = 9999, limit: int = 1000, offset: int = 0, q: str = ''):
    emails = system_settings.list_unified_inbox(days=days, limit=limit, offset=offset, q=q)
    for email in emails:
        _annotate_list_identity(email, email.pop("_contact_names", {}))
        email.pop("body_text", None)
        email.pop("body_html", None)
    return emails


class CleanupPreviewRequest(BaseModel):
    offset: int = Field(default=0, ge=0, le=10000000)
    folder: str
    before_date: str
    include_favorites: bool = False


class CleanupExecuteRequest(BaseModel):
    token: str
    confirmation: str
    acknowledge: bool = False


@app.post('/api/system/server-cleanup/preview')
def api_cleanup_preview(payload: CleanupPreviewRequest):
    from .. import server_cleanup
    try:
        return server_cleanup.preview(payload.folder, payload.before_date, payload.include_favorites, payload.offset)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(502, f'预览失败：{exc}')


@app.post('/api/system/server-cleanup/execute')
def api_cleanup_execute(payload: CleanupExecuteRequest):
    from .. import server_cleanup
    if not pipeline._poll_lock.acquire(blocking=False):
        raise HTTPException(409, '邮件正在同步，请等待同步完成后重新预览')
    try:
        return server_cleanup.execute(payload.token, payload.confirmation, payload.acknowledge)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    finally:
        pipeline._poll_lock.release()


@app.get('/api/system/server-cleanup/history')
def api_cleanup_history():
    from .. import server_cleanup
    return server_cleanup.history()


@app.get("/api/system/backups")
def api_backups():
    return system_settings.list_backups()


class PortableExportRequest(BaseModel):
    include_raw: bool = True
    password: str = Field(default="", max_length=1024)


class PortableImportRequest(BaseModel):
    import_token: str = Field(min_length=32, max_length=32)
    password: str = Field(default="", max_length=1024)


@app.post("/api/system/portable-backups")
def api_create_portable_backup(payload: PortableExportRequest):
    from .. import portable_backup
    try:
        return portable_backup.create(include_raw=payload.include_raw, password=payload.password)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/system/portable-backups")
def api_portable_backups():
    from .. import portable_backup
    return portable_backup.list_stored()


@app.get("/api/system/portable-backups/download/{filename}")
def api_download_portable_backup(filename: str):
    from .. import portable_backup
    try:
        return FileResponse(portable_backup.stored_path(filename), filename=filename,
                            media_type="application/octet-stream")
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))


@app.delete("/api/system/portable-backups/stored/{filename}")
def api_delete_portable_backup(filename: str):
    from .. import portable_backup
    try:
        return portable_backup.delete_stored(filename)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))
    except OSError as exc:
        raise HTTPException(409, f"无法删除迁移包：{exc}")


@app.post("/api/system/portable-backups/inspect")
async def api_inspect_portable_backup(request: Request, x_migration_password: str = Header(default="", max_length=1024)):
    from .. import portable_backup
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


@app.post("/api/system/portable-backups/restore")
def api_restore_portable_backup(payload: PortableImportRequest):
    from .. import portable_backup
    if not pipeline._poll_lock.acquire(blocking=False):
        raise HTTPException(409, "邮件正在同步，请等待同步完成后导入")
    try:
        return portable_backup.restore_staged(payload.import_token, password=payload.password)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as exc:
        raise HTTPException(400, str(exc))
    finally:
        pipeline._poll_lock.release()


@app.delete("/api/system/portable-backups/import/{token}")
def api_discard_portable_backup(token: str):
    from .. import portable_backup
    try:
        return portable_backup.discard_staged(token)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc))


@app.post("/api/system/backups")
def api_create_backup(include_raw: bool = True):
    try:
        return system_settings.create_backup(include_raw)
    except Exception as exc:
        log.exception("创建备份失败")
        raise HTTPException(500, f"创建备份失败: {exc}")


@app.get("/api/system/backups/{filename}")
def api_download_backup(filename: str):
    try:
        return FileResponse(system_settings.backup_path(filename), filename=filename,
                            media_type="application/zip")
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "备份文件不存在")


@app.delete("/api/system/backups/{filename}")
def api_delete_backup(filename: str):
    try:
        return system_settings.delete_backup(filename)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "备份文件不存在")
    except OSError as exc:
        raise HTTPException(409, f"无法删除备份：{exc}")


@app.post("/api/system/backups/{filename}/restore")
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


@app.post("/api/system/model")
def api_model_config(payload: ModelConfigRequest):
    switching = payload.model_fields_set == {'provider'}
    if not switching and (not payload.base_url.strip() or not payload.model.strip()):
        raise HTTPException(400, "请填写 API 地址和模型名称")
    try:
        system_settings.save_model(payload.model_dump(include={'provider'}) if switching else payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {"ok": True, "config": system_settings.public_config()}


@app.post("/api/system/model/test")
def api_model_test(payload: ModelConfigRequest | None = None):
    return system_settings.test_model(payload.model_dump() if payload else None)


@app.get("/api/system/diagnostics")
def api_system_diagnostics():
    return system_settings.diagnostics()


@app.get("/api/rules")
def api_rules():
    return {"rules": policy.list_rules(), "thresholds": policy.thresholds(),
            "allowlist": policy.list_allowlist_entries(), "categories": policy.list_categories()}


@app.post("/api/rules/allowlist")
def api_save_allowlist(payload: AllowlistRequest):
    kind = payload.kind if payload.kind in {"domain", "address"} else "domain"
    value = policy.normalize_address(payload.domain) if kind == "address" else policy.normalize_domain(payload.domain)
    if not value:
        example = "name@partner.example.com" if kind == "address" else "partner.example.com"
        raise HTTPException(400, f"请输入有效{'邮箱地址' if kind == 'address' else '域名'}，例如 {example}")
    note = payload.note.strip()[:200]
    entry = (db.upsert_security_allowlist_address(value, payload.enabled, note) if kind == "address"
             else db.upsert_security_allowlist(value, payload.enabled, note) | {"kind": "domain", "value": value})
    db.add_audit_log(None, action="allowlist_change", actor="user",
                     reason=f"{'启用' if payload.enabled else '停用'}可信{('邮箱' if kind == 'address' else '域名')} {value}",
                     meta={"kind": kind, "value": value, "enabled": payload.enabled, "note": note})
    return {"ok": True, "entry": entry}


@app.delete("/api/rules/allowlist/{entry_id}")
def api_delete_allowlist(entry_id: int):
    entries = {item["id"]: item for item in db.list_security_allowlist() if item.get("kind") == "domain"}
    entry = entries.get(entry_id)
    if not entry or not db.delete_security_allowlist(entry_id):
        raise HTTPException(404, "白名单记录不存在")
    db.add_audit_log(None, action="allowlist_delete", actor="user",
                     reason=f"删除可信域名 {entry['domain']}", meta={"domain": entry["domain"]})
    return {"ok": True}


@app.delete("/api/rules/allowlist/{kind}/{entry_id}")
def api_delete_allowlist_typed(kind: str, entry_id: int):
    if kind not in {"domain", "address"}:
        raise HTTPException(400, "白名单类型无效")
    entries = {(item["kind"], item["id"]): item for item in db.list_security_allowlist()}
    entry = entries.get((kind, entry_id))
    deleted = (db.delete_security_allowlist_address(entry_id) if kind == "address"
               else db.delete_security_allowlist(entry_id))
    if not entry or not deleted:
        raise HTTPException(404, "白名单记录不存在")
    db.add_audit_log(None, action="allowlist_delete", actor="user",
                     reason=f"删除可信{('邮箱' if kind == 'address' else '域名')} {entry['value']}", meta=entry)
    return {"ok": True}


@app.post("/api/rules/categories/{category}")
def api_update_rule_category(category: str, payload: RuleCategoryRequest):
    try:
        rules = policy.configure_category(category, payload.enabled, payload.sensitivity)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    db.add_audit_log(None, action="rule_category_change", actor="user",
                     reason=f"更新{category}：{'开启' if payload.enabled else '关闭'}，{payload.sensitivity}",
                     meta={"category": category, **payload.model_dump()})
    return {"ok": True, "rules": rules, "categories": policy.list_categories()}


@app.post("/api/rules/{code}")
def api_update_rule(code: str, enabled: bool, weight: int):
    if code not in policy.CATALOG:
        raise HTTPException(404, "规则不存在")
    if weight < 0 or weight > 100:
        raise HTTPException(400, "权重必须在 0 到 100 之间")
    db.set_rule_setting(code, enabled, weight)
    db.add_audit_log(None, action="rule_config_change", actor="user",
                     reason=f"规则 {code}：{'启用' if enabled else '停用'}，权重 {weight}",
                     meta={"code": code, "enabled": enabled, "weight": weight})
    return {"ok": True}


@app.post("/api/rules/thresholds/update")
def api_update_thresholds(review_score: int, quarantine_score: int, spam_score: int):
    if not (0 <= review_score < quarantine_score <= 100):
        raise HTTPException(400, "人工复核阈值必须小于隔离阈值，且范围为 0-100")
    if not 0 <= spam_score <= 100:
        raise HTTPException(400, "垃圾邮件阈值范围为 0-100")
    for key, value in {"review_score": review_score, "quarantine_score": quarantine_score,
                       "spam_score": spam_score}.items():
        db.set_runtime_setting(key, str(value))
    db.add_audit_log(None, action="threshold_config_change", actor="user",
                     reason="更新风险判定阈值", meta=policy.thresholds())
    return {"ok": True, "thresholds": policy.thresholds()}


@app.post("/api/rules/actions/reset")
def api_reset_rules():
    db.delete_rule_settings()
    for key, value in policy.THRESHOLD_DEFAULTS.items():
        db.set_runtime_setting(key, str(value))
    db.add_audit_log(None, action="rule_config_reset", actor="user", reason="恢复规则默认配置")
    return {"ok": True}


def _resolved_contact_name(address: str, current_name: str, names: dict[str, dict]) -> tuple[str, str]:
    normalized_address = str(address or "").strip().casefold()
    current = str(current_name or "").strip().strip('"').strip()
    current_key = current.casefold()
    local_part = normalized_address.partition("@")[0]
    weak_placeholder = bool(current_key) and current_key in {normalized_address, local_part}
    match = names.get(normalized_address) or {}
    # A name explicitly saved by the user is authoritative. Learned history only
    # fills missing/placeholder names and never replaces a meaningful message name.
    if match.get("name") and (
        match.get("source") == "manual" or not current or "@" in current or weak_placeholder
    ):
        return str(match["name"]), str(match.get("source") or "history")
    return current, "message" if current else ""


def _annotate_list_identity(item: dict, names: dict[str, dict] | None = None) -> None:
    """Describe the user's role and the useful counterparty for compact list rows."""
    names = names or {}
    sender = str(item.get("from_addr") or "").strip().casefold()
    current = str(config.IMAP_USER or "").strip().casefold()
    outgoing = bool(current and sender == current) or item.get("status") in ("sent", "draft")
    if outgoing:
        recipients = [(name.strip(), address.strip()) for name, address in getaddresses(
            [str(item.get("to_addr") or "")]
        ) if address.strip()]
        name, address = recipients[0] if recipients else ("", str(item.get("to_addr") or "").strip())
        name, source = _resolved_contact_name(address, name, names)
        recipient_names = {}
        for original_name, recipient in getaddresses([
            str(value) for value in (item.get("to_addr"), item.get("cc_addr"), item.get("bcc_addr")) if value
        ]):
            resolved, _resolved_source = _resolved_contact_name(recipient, original_name, names)
            if recipient and resolved:
                recipient_names[recipient.casefold()] = resolved
        item.update(direction="outgoing", direction_label="发给",
                    counterpart_name=name, counterpart_addr=address,
                    counterpart_count=len(recipients) or int(bool(address)),
                    counterpart_name_source=source, recipient_names=recipient_names)
    else:
        address = str(item.get("from_addr") or "").strip()
        name, source = _resolved_contact_name(address, item.get("from_name"), names)
        if name:
            item["from_name"] = name
        item.update(direction="incoming", direction_label="来自",
                    counterpart_name=name, counterpart_addr=address,
                    counterpart_count=1, counterpart_name_source=source)


def _annotate_list_identities(items: list[dict]) -> None:
    names = db.contact_display_names([
        value for item in items
        for value in (item.get("from_addr"), item.get("to_addr"), item.get("cc_addr"), item.get("bcc_addr"))
        if value
    ])
    for item in items:
        _annotate_list_identity(item, names)


@app.get("/api/mail/folders")
def api_mail_folders():
    try:
        with MailClient() as mail:
            return mail.list_mailboxes()
    except Exception as exc:
        log.exception("读取邮件文件夹失败")
        raise HTTPException(502, f"读取邮件文件夹失败: {exc}")


@app.post("/api/mail/folders/sync")
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


@app.post("/api/mail/folders")
def api_create_mail_folder(payload: FolderRequest):
    name = payload.name.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "文件夹名称无效")
    try:
        with MailClient() as mail:
            mail.create_mailbox(name)
        return {"ok": True, "name": name}
    except Exception as exc:
        raise HTTPException(502, f"创建文件夹失败: {exc}")


@app.delete("/api/mail/folders")
def api_delete_mail_folder(name: str):
    protected = {config.INBOX_FOLDER, config.QUARANTINE_FOLDER, config.SPAM_FOLDER}
    if name in protected:
        raise HTTPException(400, "系统文件夹不能删除")
    try:
        with MailClient() as mail:
            mail.delete_mailbox(name)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"删除文件夹失败: {exc}")


@app.get("/api/drafts")
def api_drafts():
    local = db.list_drafts()
    remote = []
    for row in db.list_special_folder_emails("draft"):
        rich_body = extract_rich_body(row.get("raw_path"), row["id"]) or row.get("body_html") or ""
        remote.append({**row, "body_html": rich_body, "id": -row["id"], "remote_email_id": row["id"],
                       "updated_at": row.get("date"), "attachments": row.get("attachments") or [],
                       "_remote": True})
    return local + remote


@app.get("/api/drafts/{draft_id}")
def api_draft(draft_id: int):
    row = db.get_draft(draft_id)
    if not row:
        raise HTTPException(404, "草稿不存在")
    return row


@app.post("/api/drafts")
def api_save_draft(payload: DraftRequest):
    from ..outbox import draft_pending
    if payload.id and not db.get_draft(payload.id):
        raise HTTPException(409, "草稿已发送或删除，请关闭编辑窗口后重新打开")
    if draft_pending(payload.id):
        raise HTTPException(409, '这份草稿已有发送任务，请先在任务与发件箱中撤销或确认发送结果')
    if payload.source_draft_email_id:
        source = db.get_email(payload.source_draft_email_id)
        if not source or source.get("status") != "draft" or source.get("remote_missing"):
            raise HTTPException(409, "来源服务器草稿已变化，请重新打开草稿")
    draft_id = db.save_draft(payload.model_dump(), payload.id)
    return {"ok": True, "id": draft_id}


@app.delete("/api/drafts/{draft_id}")
def api_delete_draft(draft_id: int):
    from ..outbox import draft_pending
    if draft_pending(draft_id):
        raise HTTPException(409, '草稿已有发送任务，请先撤销发送或核对发送结果')
    if draft_id < 0:
        email_id = -draft_id
        row = db.get_email(email_id)
        if not row or row.get("status") != "draft":
            raise HTTPException(404, "服务器草稿不存在")
        try:
            with MailClient() as mail:
                target_uid, target = mail.move_to_trash(row["uid"], row["folder"])
            db.set_status(email_id, "trash", target)
            db.set_mail_state(email_id, uid=target_uid)
            db.add_audit_log(email_id, "discard_remote_draft", actor="user",
                             reason=f"移动服务器草稿到 {target}")
            return {"ok": True, "remote": True, "folder": target}
        except Exception as exc:
            log.exception("舍弃服务器草稿失败")
            raise HTTPException(502, f"舍弃服务器草稿失败: {exc}")
    db.delete_draft(draft_id)
    return {"ok": True}


@app.get("/api/mail/sent")
def api_sent_messages(limit: int = 500):
    local = db.list_sent_messages(limit)
    local_message_ids = {str(item.get("message_id") or "").strip().casefold()
                         for item in local if item.get("message_id")}
    remote = []
    for row in db.list_special_folder_emails("sent", limit):
        message_id = str(row.get("message_id") or "").strip().casefold()
        if message_id and message_id in local_message_ids:
            continue
        rich_body = extract_rich_body(row.get("raw_path"), row["id"]) or row.get("body_html") or ""
        remote.append({**row, "body_html": rich_body, "id": -row["id"], "remote_email_id": row["id"],
                       "sent_at": row.get("date"), "status": "sent",
                       "attachments": row.get("attachments") or [], "_remote": True})
    result = sorted(local + remote, key=lambda item: item.get("sent_at") or item.get("created_at") or "",
                    reverse=True)[:max(1, min(limit, 5000))]
    _annotate_list_identities(result)
    return result


@app.get("/api/mail/sent/{record_id}")
def api_sent_message(record_id: int):
    row = db.get_sent_message(record_id)
    if not row:
        raise HTTPException(404, "发送记录不存在")
    return row


@app.get("/api/mail/send-capability")
def api_send_capability():
    configured = smtp_client.configured()
    matched = smtp_client.identity_matches_current_mailbox()
    verified = system_settings.current_smtp_verified()
    if not configured:
        reason = "当前邮箱尚未配置 SMTP"
    elif not matched:
        reason = "测试 SMTP 与当前企业邮箱不一致"
    elif not verified:
        reason = "收件邮箱已连接，但发件服务尚未验证；请在邮箱账号设置中修复"
    else:
        reason = ""
    return {
        "configured": matched and verified,
        "from_addr": config.IMAP_USER,
        "smtp_configured": configured,
        "identity_matched": matched,
        "smtp_verified": verified,
        "reason": reason,
    }


@app.post("/api/mail/compose/assist")
def api_compose_assist(payload: ComposeAssistRequest):
    operations = {
        "draft": "根据主题和已有要点起草一封完整邮件",
        "reply": "根据原邮件和已有内容生成直接、完整的回复",
        "forward": "根据原邮件和已有内容生成简洁的转发说明，只说明转发目的和希望收件人采取的行动，不复述完整原邮件",
        "polish": "润色邮件，修正语病并保持原意",
        "shorten": "压缩邮件，使其更简洁但不遗漏关键事项",
        "translate_en": "将邮件翻译为自然、专业的英文",
    }
    instruction = operations.get(payload.operation)
    if not instruction:
        raise HTTPException(400, "不支持的 AI 写信操作")
    if payload.operation in {"polish", "shorten", "translate_en"} and not payload.body_text.strip():
        raise HTTPException(400, "请先填写需要改写的正文")

    references: list[tuple[str, str]] = []
    basis: list[str] = []
    values = (
        ("写作要求", payload.user_instruction[:1000]),
        ("邮件主题", payload.subject[:300]),
        ("收件人", payload.recipients[:1000]),
        ("原邮件", payload.original_text[:5000]),
        ("已有正文", payload.body_text[:5000]),
    )
    for label, value in values:
        if value.strip():
            basis.append(label)
            references.append((label, value.strip()))
    attachment_names = [str(name).strip()[:240] for name in payload.attachment_names[:20] if str(name).strip()]
    if attachment_names:
        basis.append("附件名称")
        references.append(("附件名称（仅文件名，未读取附件正文）", "；".join(attachment_names)))
    if not references:
        raise HTTPException(400, "请先填写写作要求、主题或正文")

    length_guidance = {
        "简短": "控制在 120 字左右，直达结论和行动项",
        "详细": "可分段说明背景、事项和下一步，但避免冗余",
    }.get(payload.length, "篇幅适中，完整覆盖关键事项")
    reference_text = "\n\n".join(f"【{label}】\n{value}" for label, value in references)
    messages = [
        {"role": "system", "content": "你是企业邮件写作助手。只输出可直接使用的邮件正文，不解释过程，不使用 Markdown 代码块。严格依据用户提供的参考内容，不得虚构姓名、日期、数字、附件内容或承诺；信息不足时使用中性表达或明确保留待确认项。"},
        {"role": "user", "content": f"任务：{instruction}\n语气：{payload.tone}\n篇幅：{length_guidance}\n\n以下是本次允许参考的内容：\n{reference_text}"},
    ]
    result = llm_client.chat_completion(messages, temperature=0.25, max_tokens=1200, timeout=45)
    if not result:
        raise HTTPException(502, "AI 写作服务暂时不可用")
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    if not content:
        raise HTTPException(502, "AI 没有返回可用正文")
    return {"ok": True, "content": content, "basis": basis}


@app.get("/api/mail/signatures")
def api_mail_signatures():
    return signatures.load()


@app.post("/api/mail/signatures")
def api_save_mail_signature(payload: SignatureRequest):
    try:
        return signatures.save(payload.model_dump(), payload.profile, payload.make_default)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.delete("/api/mail/signatures/{signature_id}")
def api_delete_mail_signature(signature_id: str):
    return signatures.delete(signature_id)


@app.post("/api/mail/signatures/{signature_id}/default")
def api_default_mail_signature(signature_id: str):
    try:
        return signatures.set_default("" if signature_id == "none" else signature_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.post("/api/mail/signatures/generate")
def api_generate_mail_signature(payload: SignatureGenerateRequest):
    try:
        return {"ok": True, "options": signatures.generate(payload.profile, payload.style)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


@app.post("/api/mail/preflight")
def api_mail_preflight(payload: MailPreflightRequest):
    try:
        normalized = smtp_client.normalize_recipient_fields(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    envelope_recipients = normalized.pop("recipients")
    if not envelope_recipients:
        raise HTTPException(400, "至少需要一个有效的收件人")
    review = outgoing_guard.review(payload.model_dump(), envelope_recipients)
    return {**review, "recipients": smtp_client.recipient_fields_for_display(normalized),
            "recipient_count": len(envelope_recipients)}


def _valid_contact_email(value: str) -> str:
    email = (value or "").strip().lower()
    if not re.fullmatch(r"[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+", email):
        raise HTTPException(400, "请输入有效的邮箱地址")
    return email


@app.get("/api/mail/contacts")
def api_mail_contacts(q: str = "", limit: int = 20, favorites_only: bool = False, group_name: str = ""):
    return db.search_contacts(q, limit, favorites_only, group_name)


class ContactGroupRequest(BaseModel):
    name: str
    previous: str | None = None


@app.get('/api/mail/contact-groups')
def api_contact_groups():
    return db.list_contact_groups()


@app.post('/api/mail/contact-groups')
def api_save_contact_group(payload: ContactGroupRequest):
    try:
        return db.save_contact_group(payload.name, payload.previous)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.delete('/api/mail/contact-groups')
def api_delete_contact_group(name: str):
    return db.delete_contact_group(name)


class ContactGroupMembersRequest(BaseModel):
    name: str
    emails: list[str] = Field(min_length=1, max_length=300)
    remove: bool = False


@app.post('/api/mail/contact-groups/members')
def api_contact_group_members(payload: ContactGroupMembersRequest):
    try:
        return db.update_contact_group_members(payload.name, [_valid_contact_email(email) for email in payload.emails], remove=payload.remove)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/mail/contacts")
def api_save_contact(payload: ContactRequest):
    email = _valid_contact_email(payload.email)
    result = db.save_contact(email, payload.name, payload.company, payload.note, payload.favorite)
    with db.conn() as c:
        if payload.group_name.strip():
            c.execute('INSERT OR IGNORE INTO contact_groups(name) VALUES(?)', (payload.group_name.strip()[:80],))
        c.execute('UPDATE contacts SET group_name=? WHERE email=?', (payload.group_name.strip()[:80], email))
    return {**result, 'group_name': payload.group_name.strip()[:80]}


@app.post('/api/emails/{email_id}/remind')
def api_remind_email(email_id: int, payload: dict):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, '邮件不存在')
    try:
        when = datetime.fromisoformat(str(payload.get('at', '')))
        if when.tzinfo is not None:
            when = when.astimezone().replace(tzinfo=None)
        if when <= datetime.now():
            raise ValueError()
    except ValueError:
        raise HTTPException(400, '请选择将来的提醒时间')
    from .. import task_planner
    try:
        task = task_planner.save(email_id=email_id)
        task = task_planner.save(todo_id=task['id'], remind_at=when.isoformat())
        return {'ok': True, 'todo_id': task['id']}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get('/api/reminders')
def api_reminders():
    reminders = json.loads(db.get_runtime_settings().get('mail_reminders', '{}'))
    return [{'email_id': int(key), **value} for key, value in reminders.items()] + [
        {'email_id':task['email_id'], 'todo_id':task['id'], 'at':task['remind_at'], 'subject':task['title']}
        for task in db.list_todos() if task.get('remind_at')]


@app.delete('/api/task-reminders/{todo_id}')
def api_dismiss_task_reminder(todo_id: int):
    from .. import task_planner
    try:
        task_planner.save(todo_id=todo_id, remind_at='')
        return {'ok': True}
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.delete('/api/reminders/{email_id}')
def api_dismiss_reminder(email_id: int):
    reminders = json.loads(db.get_runtime_settings().get('mail_reminders', '{}'))
    reminders.pop(str(email_id), None)
    db.set_runtime_setting('mail_reminders', json.dumps(reminders, ensure_ascii=False))
    return {'ok': True}


@app.get('/api/reminders/all')
def api_all_reminders():
    from ..account_context import snapshot, use
    items = []
    for account_id, account in system_settings._load_registry().get('accounts', {}).items():
        try:
            with use(snapshot(account_id)):
                items.extend({**item, 'account_id': account_id, 'account_user': account['user']} for item in api_reminders())
        except (ValueError, OSError):
            continue
    return items


@app.post('/api/emails/{email_id}/todo')
def api_email_todo(email_id: int, payload: TodoUpdateRequest | None = None):
    from .. import task_planner
    try:
        return {'ok': True, 'task': task_planner.save(email_id=email_id, **(payload.model_dump(exclude_none=True) if payload else {}))}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.patch("/api/mail/contacts/favorite")
def api_favorite_contact(payload: ContactFavoriteRequest):
    return db.set_contact_favorite(_valid_contact_email(payload.email), payload.favorite)


@app.delete("/api/mail/contacts")
def api_delete_contact(email: str):
    db.hide_contact(_valid_contact_email(email))
    return {"ok": True}


@app.post("/api/mail/send")
def api_send_mail(payload: SendMailRequest):
    data = payload.model_dump()
    data["from_addr"] = config.IMAP_USER
    try:
        normalized = smtp_client.normalize_recipient_fields(data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    envelope_recipients = normalized.pop("recipients")
    if not envelope_recipients:
        raise HTTPException(400, "至少需要一个有效的收件人")
    data.update(normalized)
    local_review = outgoing_guard.local_issues({
        **data,
        "body_text": mail_parser.strip_html(payload.body_html),
        "attachment_names": [str(item.get("name") or "") for item in payload.attachments if isinstance(item, dict)],
        "attachment_count": len(payload.attachments),
    }, envelope_recipients)
    dangerous = [item for item in local_review if item.get("level") == "danger"]
    if dangerous and not payload.preflight_confirmed:
        raise HTTPException(400, f"发送前仍有高风险项未确认：{dangerous[0]['message']}")
    record_id = db.create_sent_message(data)
    result = None
    try:
        result = smtp_client.send(data)
        db.finish_sent_message(record_id, ok=True, error=result.get("warning", ""),
                               smtp_response="partially accepted" if result.get("refused_recipients") else "accepted",
                               sent_folder=result["sent_folder"], message_id=result.get("message_id", ""))
        if payload.id:
            db.complete_sent_draft(payload.id)
        db.add_audit_log(None, "send_mail", actor="user", reason=f"发送邮件：{payload.subject}",
                         meta={"message_id": result["message_id"], "recipients": result["recipients"],
                               "preflight_issues": [item["code"] for item in local_review]})
        return {"ok": True, **result}
    except Exception as exc:
        if result is not None:
            log.exception("SMTP 已接收邮件，但本地发送记录更新失败")
            return {"ok": True, **result, "warning": (result.get("warning", "") +
                    " 邮件已被服务器接受，但本地记录更新失败，请勿重复发送。")}
        db.finish_sent_message(record_id, ok=False, error=str(exc)[:500])
        log.exception("发送邮件失败")
        import smtplib
        if isinstance(exc, (smtplib.SMTPRecipientsRefused, smtplib.SMTPAuthenticationError, smtplib.SMTPDataError, ValueError)):
            raise HTTPException(400, f"服务器未接受邮件：{exc}")
        raise HTTPException(502, f"发送失败: {exc}")


@app.get("/api/assistant/alerts")
def api_assistant_alerts():
    return mail_assistant.alerts()


@app.get('/api/assistant/briefing')
def api_assistant_briefing(focus: str = 'execution'):
    from .. import secretary
    try:
        return secretary.briefing(focus)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post('/api/emails/{email_id}/briefing-dismiss')
def api_briefing_dismiss(email_id: int):
    if not db.get_email(email_id):
        raise HTTPException(404, '邮件不存在')
    with db.conn() as c:
        c.execute('INSERT OR IGNORE INTO briefing_dismissed VALUES(?)', (email_id,))
    return {'ok': True}


@app.delete('/api/emails/{email_id}/briefing-dismiss')
def api_briefing_restore(email_id: int):
    with db.conn() as c:
        c.execute('DELETE FROM briefing_dismissed WHERE email_id=?', (email_id,))
    return {'ok': True}


@app.post("/api/assistant/alerts/seen")
def api_assistant_alerts_seen(payload: dict | None = None):
    return {"ok": True, "seen_at": mail_assistant.mark_risk_alerts_seen((payload or {}).get('ids', []))}


@app.post("/api/assistant/ask")
def api_assistant_ask(payload: AssistantRequest):
    from .. import assistant_vision, assistant_attachments
    images = _prepare_assistant_images(payload)
    materials = _prepare_assistant_materials(payload, images)
    try:
        conversation_id = payload.conversation_id
        if not conversation_id or not db.assistant_conversation_exists(conversation_id):
            conversation_id = db.create_assistant_conversation(payload.question.strip()[:36] or "新对话")
        db.add_assistant_message(conversation_id, "user", assistant_attachments.history_text(assistant_vision.history_text(payload.question, images),materials), images=images)
        result = mail_assistant.ask(payload.question, payload.history, payload.email_ids, **({'images': images} if images else {}), **({'materials':materials} if materials else {}))
        db.add_assistant_message(conversation_id, "assistant", result["answer"], result.get("sources") or [])
        return {**result, "conversation_id": conversation_id}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        log.exception("邮件助手回答失败")
        raise HTTPException(500, f"助手暂时不可用: {exc}")


@app.post("/api/assistant/ask-stream")
def api_assistant_ask_stream(payload: AssistantRequest):
    from .. import assistant_vision, assistant_attachments
    images = _prepare_assistant_images(payload)
    materials = _prepare_assistant_materials(payload, images)
    conversation_id = payload.conversation_id
    if not conversation_id or not db.assistant_conversation_exists(conversation_id):
        conversation_id = db.create_assistant_conversation(payload.question.strip()[:36] or "新对话")
    db.add_assistant_message(conversation_id, "user", assistant_attachments.history_text(assistant_vision.history_text(payload.question, images),materials), images=images)

    def generate():
        answer_parts, sources = [], []
        try:
            yield json.dumps({"type": "meta", "conversation_id": conversation_id}, ensure_ascii=False) + "\n"
            yield json.dumps({'type': 'scope', 'label': payload.scope_label or config.IMAP_USER}, ensure_ascii=False) + '\n'
            for event, value in mail_assistant.ask_stream(payload.question, payload.history, payload.email_ids, **({'images': images} if images else {}), **({'materials':materials} if materials else {})):
                if event == "sources":
                    sources = value
                    yield json.dumps({"type": "sources", "sources": value}, ensure_ascii=False) + "\n"
                elif event == "status":
                    yield json.dumps({"type": "status", **value}, ensure_ascii=False) + "\n"
                else:
                    answer_parts.append(value)
                    yield json.dumps({"type": "delta", "content": value}, ensure_ascii=False) + "\n"
            answer = "".join(answer_parts).strip()
            answer = mail_assistant.validated_citations(answer, sources)
            if not answer:
                answer = mail_assistant._empty_answer(payload.question)
                yield json.dumps({"type": "delta", "content": answer}, ensure_ascii=False) + "\n"
            db.add_assistant_message(conversation_id, "assistant", answer, sources)
            yield json.dumps({"type": "done"}, ensure_ascii=False) + "\n"
        except Exception as exc:
            log.exception("助手流式回答失败")
            message = str(exc) if isinstance(exc, assistant_vision.ImageAnalysisError) else '分析中断，已生成的内容保留，可重试。'
            answer = mail_assistant.validated_citations(''.join(answer_parts), sources) + '\n\n' + message
            db.add_assistant_message(conversation_id, "assistant", answer, sources)
            yield json.dumps({"type": "error", "message": message}, ensure_ascii=False) + "\n"
    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.get("/api/assistant/conversations")
def api_assistant_conversations(limit: int = 50):
    return db.list_assistant_conversations(limit)


@app.get("/api/assistant/images/{image_id}")
def api_assistant_image(image_id: int, thumbnail: bool = False):
    item = db.get_assistant_image(image_id, thumbnail)
    if not item:
        raise HTTPException(404, "图片不存在或已清理")
    return Response(item['data'], media_type='image/jpeg' if thumbnail else item['mime'],
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


@app.get("/api/assistant/conversations/{conversation_id}")
def api_assistant_conversation(conversation_id: int):
    if not db.assistant_conversation_exists(conversation_id):
        raise HTTPException(404, "会话不存在")
    return {"id": conversation_id, "messages": db.get_assistant_messages(conversation_id)}


@app.get("/api/emails")
def api_emails(status: str | None = None, verdict: str | None = None, days: int = 7,
               folder: str | None = None, offset: int = 0):
    emails = db.list_emails(status=status, verdict=verdict, days=days, folder=folder,
                            offset=offset, list_view=True)
    _annotate_list_identities(emails)
    for e in emails:  # 列表页不返回全文
        if status == "trash" and e.get("pending_action"):
            e["status"] = "trash"
        e.pop("body_text", None)
        e.pop("body_html", None)
    return emails


@app.get("/api/mailbox/revision")
def api_mailbox_revision():
    """Lightweight browser heartbeat used to reveal background-delivered mail."""
    import sqlite3
    revisions = []
    for account_id, account in system_settings._load_registry().get('accounts', {}).items():
        if not account.get('visible', True) or not os.path.isfile(account.get('db_path', '')):
            continue
        try:
            with system_settings._sqlite_connection(account['db_path']) as c:
                row = c.execute('SELECT COUNT(*),COALESCE(MAX(id),0) FROM emails WHERE remote_missing=0').fetchone()
                seq = c.execute('SELECT value FROM mailbox_sequence WHERE id=1').fetchone()[0]
            revisions.append(f'{account_id}:{row[0]}:{row[1]}:{seq}')
        except sqlite3.Error:
            continue
    return {**db.mailbox_revision(), 'revision': '|'.join(sorted(revisions)) or db.mailbox_revision()['revision'], "syncing": pipeline.is_fetch_running()}


@app.get("/api/emails/search")
def api_search_emails(q: str = "", limit: int = 1000, offset: int = 0, folder: str = ""):
    emails = db.search_emails([part for part in re.split(r"\s+", q.strip()) if part],
                              max(1, min(limit, 1000)), offset=offset, list_view=True, folder=folder)
    _annotate_list_identities(emails)
    for item in emails:
        item.pop("body_text", None)
    return emails


@app.get("/api/attachments")
def api_attachments(limit: int = 500):
    return db.list_attachments(max(1, min(limit, 1000)))


@app.post("/api/emails/{email_id}/read")
def api_set_email_read(email_id: int, value: bool = True):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    before, _ = db.queue_seen_sync([email_id], value)
    if not before:
        raise HTTPException(409, "邮件当前无法更新")
    db.add_audit_log(email_id, "mark_read" if value else "mark_unread", actor="user",
                     reason="本地立即更新，后台同步邮箱服务器")
    return {"ok": True, "is_read": value, "sync_pending": True}


@app.post('/api/emails/{email_id}/favorite')
def api_set_email_favorite(email_id: int, value: bool = True):
    with db.conn() as c:
        result = c.execute('UPDATE emails SET is_favorite=? WHERE id=?', (int(value), email_id))
        if not result.rowcount:
            raise HTTPException(404, '邮件不存在')
    return {'ok': True, 'is_favorite': value}


@app.post("/api/emails/{email_id}/star")
def api_set_email_star(email_id: int, value: bool = True):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    if row.get('is_local_archive') or row.get('cleanup_hold'):
        raise HTTPException(409, '仅本地保留或正在清理的邮件不能执行服务器操作，可使用本地收藏')
    try:
        with MailClient() as mail:
            mail.set_flagged(row["uid"], row["folder"], value)
        db.set_mail_state(email_id, is_starred=value)
        db.add_audit_log(email_id, "star" if value else "unstar", actor="user")
        from ..mail_undo import record
        return {"ok": True, "is_starred": value, 'undo_token': record('star', [row], [db.get_email(email_id)])}
    except Exception as exc:
        log.exception("更新星标状态失败")
        raise HTTPException(502, f"更新星标状态失败: {exc}")


@app.post("/api/emails/{email_id}/move")
def api_move_email(email_id: int, target: str):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    if not target or target == row["folder"]:
        raise HTTPException(400, "目标文件夹无效")
    if row.get('is_local_archive') or row.get('cleanup_hold'):
        raise HTTPException(409, '仅本地保留或正在清理的邮件不能执行服务器操作，可使用本地收藏')
    try:
        with MailClient() as mail:
            folders = mail.list_mailboxes()
            names = {item["name"] for item in folders}
            if target not in names:
                raise HTTPException(400, "目标文件夹不存在")
            target_uid = mail.move(row["uid"], row["folder"], target)
        db.set_mail_state(email_id, folder=target, uid=target_uid)
        db.set_status(email_id, mailbox_role(next(item for item in folders if item['name'] == target)))
        db.add_audit_log(email_id, "move_folder", actor="user", reason=f"移动到 {target}")
        from ..mail_undo import record
        return {"ok": True, "folder": target, 'undo_token': record('move', [row], [db.get_email(email_id)])}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("移动邮件失败")
        raise HTTPException(502, f"移动邮件失败: {exc}")


@app.post("/api/emails/bulk")
def api_bulk_email_action(payload: BulkMailRequest):
    ids = list(dict.fromkeys(payload.ids))
    if len(ids) > 200:
        raise HTTPException(400, '每批最多 200 封，请分批操作')
    if not ids:
        raise HTTPException(400, "请选择邮件")
    if payload.action not in ("read", "star", "move", "trash", "cancel_trash"):
        raise HTTPException(400, "不支持的批量操作")
    rows = [db.get_email(email_id) for email_id in ids]
    rows = [row for row in rows if row]
    if payload.action != 'read' and any(row.get('is_local_archive') or row.get('cleanup_hold') for row in rows):
        raise HTTPException(409, '所选邮件包含仅本地保留或正在清理的邮件，不能执行服务器操作')
    if not rows:
        raise HTTPException(404, "所选邮件不存在")
    if payload.action == "cancel_trash":
        completed = 0
        failed = []
        for row in rows:
            if db.cancel_pending_trash(row['id']):
                completed += 1
                db.add_audit_log(row['id'], 'cancel_trash', actor='user', reason='恢复到删除前的位置')
            else:
                failed.append({'id': row['id'], 'error': '服务器删除同步已开始或已完成，请刷新后使用恢复到收件箱'})
        return {'ok': not failed, 'completed': completed, 'failed': failed}
    if payload.action == "move" and any(row.get('pending_action') for row in rows):
        raise HTTPException(409, '删除仍在同步，请先取消删除或等待同步完成再恢复')
    if payload.action == "trash":
        # Deletion is optimistic locally and durable remotely. Keep the source
        # folder/UID unchanged until the background two-phase operation commits,
        # so a restart or undo never has to guess the original identity.
        before, after = db.queue_trash([row['id'] for row in rows])
        queued_ids = {row['id'] for row in before}
        failed = [
            {'id': row['id'], 'error': '邮件已在已删除中，请使用恢复操作' if row.get('status') == 'trash' else '邮件已在处理或本地记录不可用'}
            for row in rows if row['id'] not in queued_ids
        ]
        for row in before:
            db.add_audit_log(row['id'], 'queue_trash', actor='user',
                             reason='本地立即隐藏，后台同步服务器垃圾箱')
        from ..mail_undo import record
        return {
            'ok': not failed, 'completed': len(before), 'queued': len(before),
            'reconciled': 0, 'failed': failed,
            'undo_token': record('trash_pending', before, after) if before else None,
        }
    if payload.action == "read":
        value = payload.value is not False
        before, after = db.queue_seen_sync([row['id'] for row in rows], value)
        queued_ids = {row['id'] for row in before}
        failed = [
            {'id': row['id'], 'error': '邮件当前无法更新'}
            for row in rows if row['id'] not in queued_ids
        ]
        failed.extend({'id': email_id, 'error': '邮件不存在'} for email_id in ids
                      if not any(row['id'] == email_id for row in rows))
        for row in before:
            db.add_audit_log(row['id'], 'bulk_read', actor='user',
                             reason=f"本地立即标记为{'已读' if value else '未读'}，后台同步服务器")
        from ..mail_undo import record
        return {
            'ok': not failed, 'completed': len(before), 'queued': len(before),
            'reconciled': 0, 'failed': failed,
            'undo_token': record('read', before, after) if before else None,
        }
    completed, reconciled, failed = 0, 0, [{'id': i, 'error': '邮件不存在'} for i in ids if not any(row['id'] == i for row in rows)]
    before, after = [], []
    try:
        with MailClient() as mail:
            folders = mail.list_mailboxes() if payload.action in ('move', 'trash') else []
            folder_names = {item['name'] for item in folders}
            if payload.action == "move" and payload.target not in folder_names:
                raise HTTPException(400, "目标文件夹不存在")
            trash_target = mail.ensure_trash_folder() if payload.action == "trash" else ""
            if payload.action == "trash":
                by_folder = {}
                for row in rows:
                    if row["folder"] == trash_target:
                        completed += 1
                    else:
                        by_folder.setdefault(row["folder"], []).append(row)
                for source_folder, folder_rows in by_folder.items():
                    batch_error = None
                    try:
                        moved = mail.move_many([row["uid"] for row in folder_rows], source_folder, trash_target)
                    except Exception as exc:
                        # One stale UID must not make every valid message in the
                        # same folder fail. The per-row recovery below safely
                        # resolves stable Message-IDs and preserves partial work.
                        log.info("批量删除降级为身份恢复 folder=%s: %s", source_folder, exc)
                        batch_error = exc
                        moved = {}
                    for row in folder_rows:
                        target_uid = moved.get(int(row["uid"]))
                        superseded_ids = []
                        if not target_uid:
                            message_id = str(row.get("message_id") or "").strip()
                            try:
                                # Retry the cached UID first because a malformed
                                # batch COPY response may still be recoverable by
                                # the idempotent single-message mover.
                                if batch_error is not None:
                                    raise batch_error
                                target_uid = mail.move(row["uid"], source_folder, trash_target)
                            except Exception as original_exc:
                                if "源邮件已不存在" not in str(original_exc):
                                    failed.append({"id": row["id"], "error": str(original_exc)[:120]})
                                    continue
                                current_uid = mail.find_message_uid(source_folder, message_id)
                                if current_uid:
                                    duplicate = db.get_email_by_folder_uid(source_folder, current_uid)
                                    if duplicate and duplicate["id"] != row["id"]:
                                        superseded_ids.append(duplicate["id"])
                                    try:
                                        target_uid = mail.move(current_uid, source_folder, trash_target)
                                    except Exception as recovery_exc:
                                        failed.append({"id": row["id"], "error": str(recovery_exc)[:120]})
                                        continue
                                else:
                                    target_uid = mail.find_message_uid(trash_target, message_id)
                                    if not target_uid and message_id:
                                        locations = []
                                        for mailbox in folders:
                                            folder = mailbox.get("name")
                                            if (not folder or not mailbox.get("selectable", True)
                                                    or folder in (source_folder, trash_target)):
                                                continue
                                            located_uid = mail.find_message_uid(folder, message_id)
                                            if located_uid:
                                                locations.append((folder, located_uid))
                                        if len(locations) == 1:
                                            actual_folder, actual_uid = locations[0]
                                            duplicate = db.get_email_by_folder_uid(actual_folder, actual_uid)
                                            if duplicate and duplicate["id"] != row["id"]:
                                                superseded_ids.append(duplicate["id"])
                                            try:
                                                target_uid = mail.move(actual_uid, actual_folder, trash_target)
                                            except Exception as recovery_exc:
                                                failed.append({"id": row["id"], "error": str(recovery_exc)[:120]})
                                                continue
                                        elif len(locations) > 1:
                                            failed.append({"id": row["id"], "error": "服务器中存在多个同标识副本，请同步后重试"})
                                            continue
                                    if not target_uid:
                                        # The intended end state (not present in
                                        # active server folders) is already true.
                                        # Hide only the stale local evidence; do
                                        # not guess or delete an unrelated UID.
                                        db.set_remote_missing(row["id"])
                                        db.add_audit_log(
                                            row["id"], "bulk_trash_remote_missing", actor="user",
                                            reason="删除时服务器已无此邮件，清理本地陈旧记录",
                                            meta={"folder": source_folder, "uid": row["uid"]},
                                        )
                                        completed += 1
                                        reconciled += 1
                                        continue
                        existing_target = db.get_email_by_folder_uid(trash_target, target_uid)
                        if existing_target and existing_target["id"] != row["id"]:
                            # Folder sync may already have imported the moved
                            # copy as another local row. Keep that canonical
                            # server-backed row and retire the stale source row
                            # instead of violating UNIQUE(folder, uid).
                            db.set_remote_missing(row["id"])
                            db.set_status(existing_target["id"], "trash", trash_target)
                            db.add_audit_log(
                                row["id"], "bulk_trash_reconcile_duplicate", actor="user",
                                reason="合并服务器移动后产生的重复本地记录",
                                meta={"canonical_email_id": existing_target["id"], "uid": target_uid},
                            )
                            completed += 1
                            reconciled += 1
                            continue
                        for duplicate_id in superseded_ids:
                            db.set_remote_missing(duplicate_id)
                        db.set_mail_state(row["id"], folder=trash_target, uid=target_uid)
                        db.set_status(row["id"], "trash")
                        db.add_audit_log(row["id"], "bulk_trash", actor="user", reason=trash_target)
                        completed += 1
                        keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred')
                        before.append({key: row.get(key) for key in keys})
                        current = db.get_email(row['id'])
                        after.append({key: current.get(key) for key in keys})
            for row in rows:
                if payload.action == "trash":
                    continue
                try:
                    if payload.action == "read":
                        value = payload.value is not False
                        mail.set_seen(row["uid"], row["folder"], value)
                        db.set_mail_state(row["id"], is_read=value)
                    elif payload.action == "star":
                        value = payload.value is not False
                        mail.set_flagged(row["uid"], row["folder"], value)
                        db.set_mail_state(row["id"], is_starred=value)
                    else:
                        if row["folder"] == payload.target:
                            completed += 1
                            continue
                        target_uid = mail.move(row["uid"], row["folder"], payload.target)
                        db.set_mail_state(row["id"], folder=payload.target, uid=target_uid)
                        target_role = mailbox_role(next(item for item in folders if item['name'] == payload.target))
                        db.set_status(row['id'], target_role)
                    db.add_audit_log(row["id"], f"bulk_{payload.action}", actor="user",
                                     reason=payload.target if payload.action == "move" else
                                     trash_target if payload.action == "trash" else str(payload.value))
                    completed += 1
                    keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred')
                    before.append({key: row.get(key) for key in keys})
                    current = db.get_email(row['id'])
                    after.append({key: current.get(key) for key in keys})
                except Exception as exc:
                    failed.append({"id": row["id"], "error": str(exc)[:120]})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"批量操作失败: {exc}")
    from ..mail_undo import record
    return {"ok": not failed, "completed": completed, "reconciled": reconciled, "failed": failed,
            # Trash is a server-resolved move; record it as such so undo moves
            # the message back instead of treating the action like a flag edit.
            'undo_token': record('move' if payload.action == 'trash' else payload.action,
                                 before, after) if before else None}


@app.post('/api/mail/undo/{token}')
def api_undo_mail(token: str):
    from ..mail_undo import restore
    try:
        return restore(token)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.get("/api/emails/{email_id}")
def api_email_detail(email_id: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    names = db.contact_display_names([row.get("from_addr"), row.get("to_addr")])
    resolved_name, _source = _resolved_contact_name(row.get("from_addr"), row.get("from_name"), names)
    if resolved_name:
        row["from_name"] = resolved_name
    row["recipient_names"] = {address: item["name"] for address, item in names.items() if item.get("name")}
    row["findings"] = policy.present_findings(row.get("findings"))
    for attachment in row.get("attachment_analysis") or []:
        if isinstance(attachment, dict):
            attachment["findings"] = policy.present_findings(attachment.get("findings"))
    row["thread_context"] = threads.build_thread_context(row)
    row["sender_profile"] = profiles.get_profile_for_display(row.get("from_addr", ""))
    row["evidence_summary"] = evidence.summarize(row.get("findings"), row.get("score", 0))
    row["campaign"] = campaigns.for_email(email_id, _campaign_groups(90)) if (
        row.get("verdict") in ("phishing", "suspicious") or int(row.get("score") or 0) >= 30
    ) else None
    row["body_html"] = row.get("body_html") or extract_rich_body(row.get("raw_path"), email_id)
    row["has_rich_body"] = bool(row["body_html"])
    row["has_remote_images"] = bool(re.search(r'<img[^>]+src=["\']https?://', row["body_html"], re.I))
    return row


@app.get("/api/emails/{email_id}/inline/{inline_index}")
def api_inline_resource(email_id: int, inline_index: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    item = extract_inline_resource(row.get("raw_path"), inline_index)
    if not item:
        raise HTTPException(404, "内嵌资源不存在")
    return Response(content=item["payload"], media_type=item["content_type"], headers={
        "Cache-Control": "private, max-age=3600", "Content-Length": str(item["size"]),
    })


@app.get("/api/drafts/{record_id}/attachments/{att_index}/preview")
def api_preview_draft_attachment(record_id: int, att_index: int, page: int = 0):
    from ..attachment_preview import preview_attachment
    att = db.get_sent_attachment(record_id, att_index, draft=True)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return preview_attachment(att, page=page)


@app.get("/api/drafts/{record_id}/attachments/{att_index}")
def api_download_draft_attachment(record_id: int, att_index: int):
    from urllib.parse import quote
    att = db.get_sent_attachment(record_id, att_index, draft=True)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return Response(content=att['payload'], media_type=att['content_type'], headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(att['name'], safe=''),
        'Content-Length': str(att['size']), 'Cache-Control': 'no-store',
    })


@app.get("/api/mail/sent/{record_id}/attachments/{att_index}/preview")
def api_preview_sent_attachment(record_id: int, att_index: int, page: int = 0):
    from ..attachment_preview import preview_attachment
    att = db.get_sent_attachment(record_id, att_index)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return preview_attachment(att, page=page)


@app.get("/api/mail/sent/{record_id}/attachments/{att_index}")
def api_download_sent_attachment(record_id: int, att_index: int):
    from urllib.parse import quote
    att = db.get_sent_attachment(record_id, att_index)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return Response(content=att['payload'], media_type=att['content_type'], headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(att['name'], safe=''),
        'Content-Length': str(att['size']), 'Cache-Control': 'no-store',
    })


@app.get("/api/emails/{email_id}/attachments/{att_index}/preview")
def api_preview_attachment(email_id: int, att_index: int, page: int = 0):
    from ..attachment_preview import preview_attachment
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    att = extract_attachment(row.get("raw_path"), att_index)
    if not att:
        raise HTTPException(404, "附件不存在或已删除")
    return preview_attachment(att, page=page)


@app.get("/api/emails/{email_id}/attachments/{att_index}")
def api_download_attachment(email_id: int, att_index: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    att = extract_attachment(row.get("raw_path"), att_index)
    if not att:
        raise HTTPException(404, "附件不存在或已删除")
    from urllib.parse import quote
    filename = quote(att["name"])
    return Response(
        content=att["payload"],
        media_type=att["content_type"],
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Content-Length": str(att["size"]),
        },
    )


@app.post("/api/emails/{email_id}/restore")
def api_restore(email_id: int):
    try:
        ok = pipeline.restore_email(email_id)
    except Exception as e:
        log.exception("恢复失败")
        raise HTTPException(500, f"恢复失败: {e}")
    if not ok:
        raise HTTPException(400, "无法恢复（邮件不存在或已在收件箱）")
    return {"ok": True}


@app.post("/api/actions/rollback-recent")
def api_rollback_recent(limit: int = 10):
    """回滚最近一批仍在隔离区/垃圾箱中的自动处置邮件。"""
    if limit < 1 or limit > 50:
        raise HTTPException(400, "limit 必须在 1 到 50 之间")
    return pipeline.rollback_recent_auto_actions(limit)


@app.post("/api/emails/{email_id}/confirm")
def api_confirm(email_id: int):
    """确认处置无误（保持隔离/垃圾状态，标记已审核）。"""
    try:
        result = pipeline.confirm_email(email_id)
    except pipeline.RemoteMessageUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        log.exception("人工确认处置失败 email_id=%s", email_id)
        raise HTTPException(502, f"确认处置失败：{str(exc)[:160]}") from exc
    if not result:
        raise HTTPException(404, "邮件不存在")
    return result


@app.post("/api/emails/{email_id}/feedback")
def api_feedback(email_id: int, feedback: str, note: str = "", trusted_sender: bool = False):
    """用户反馈：fp=误报，fn=漏报。"""
    if feedback not in ("fp", "fn"):
        raise HTTPException(400, "feedback 只能是 fp 或 fn")
    try:
        result = pipeline.record_feedback(email_id, feedback, note, trust_sender=trusted_sender)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        log.exception("反馈处置失败 email_id=%s", email_id)
        raise HTTPException(502, "邮件处置未完成，本地反馈未更新。请同步邮件后重试。") from exc
    if not result:
        raise HTTPException(404, "邮件不存在")
    return result if isinstance(result, dict) else {"ok": True, "calibrated": 0}


@app.get("/api/emails/{email_id}/reply-recipients")
def api_reply_recipients(email_id: int, reply_all: bool = False):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    try:
        return reply_recipients(row, config.IMAP_USER, reply_all)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/emails/{email_id}/thread")
def api_email_thread(email_id: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    return threads.build_thread_context(row)


def _correspondence_payload(counterpart: str, limit: int = 50) -> dict:
    """Build the shared correspondence response for message and contact entry points."""
    own_address = str(config.IMAP_USER or "").strip().casefold()
    items = db.list_correspondence_emails(counterpart, limit=max(1, min(limit, 100)))
    return {
        "counterpart": counterpart,
        "count": len(items),
        "emails": [{
            "id": item.get("id"), "date": item.get("date"),
            "from_addr": item.get("from_addr"), "from_name": item.get("from_name"),
            "to_addr": item.get("to_addr"), "subject": item.get("subject"),
            "snippet": item.get("snippet"), "verdict": item.get("verdict"),
            "score": item.get("score"), "status": item.get("status"),
            "direction": "sent" if str(item.get("from_addr") or "").strip().casefold() == own_address else "received",
        } for item in items],
    }


@app.get("/api/mail/contacts/correspondence")
def api_contact_correspondence(email: str, limit: int = 50):
    """List locally stored mail exchanged with a contact in the current account."""
    return _correspondence_payload(_valid_contact_email(email), limit)


@app.get("/api/emails/{email_id}/correspondence")
def api_email_correspondence(email_id: int, limit: int = 50):
    """List mail exchanged with the other party of the selected message."""
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    own_address = str(config.IMAP_USER or "").strip().casefold()
    sender = str(row.get("from_addr") or "").strip()
    if sender.casefold() != own_address:
        counterpart = sender
    else:
        recipients = re.findall(
            r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}",
            str(row.get("to_addr") or ""), re.I,
        )
        counterpart = next((item for item in recipients if item.casefold() != own_address), "")
    if not counterpart:
        return {"counterpart": "", "count": 0, "emails": []}
    return _correspondence_payload(counterpart, limit)


@app.get("/api/emails/{email_id}/audit")
def api_email_audit(email_id: int, limit: int = 50):
    if not db.get_email(email_id):
        raise HTTPException(404, "邮件不存在")
    return db.list_audit_logs(email_id=email_id, limit=limit)


@app.get("/api/senders/{sender}")
def api_sender_profile(sender: str):
    return profiles.get_profile_for_display(sender)


@app.get("/api/todos")
def api_todos(include_done: bool = False):
    return db.list_todos(include_done)


@app.post("/api/todos/bulk/status")
def api_todos_bulk_status(payload: TodoBulkStatusRequest):
    if payload.status not in {"open", "done"}:
        raise HTTPException(400, "待办状态仅支持 open 或 done")
    ids = sorted({todo_id for todo_id in payload.ids if todo_id > 0})
    if not ids:
        raise HTTPException(400, "请选择待办事项")
    return {"ok": True, "updated": db.set_todos_status(ids, payload.status)}


@app.post("/api/todos/{todo_id}/done")
def api_todo_done(todo_id: int):
    db.set_todo_status(todo_id, "done")
    return {"ok": True}


@app.post("/api/todos/{todo_id}/reopen")
def api_todo_reopen(todo_id: int):
    db.set_todo_status(todo_id, "open")
    return {"ok": True}


@app.patch("/api/todos/{todo_id}")
def api_todo_update(todo_id: int, payload: TodoUpdateRequest):
    if payload.title is not None and not payload.title.strip():
        raise HTTPException(400, "待办标题不能为空")
    if payload.deadline:
        try:
            datetime.strptime(payload.deadline, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "截止日期必须是有效的 YYYY-MM-DD 日期")
    with db.conn() as connection:
        if not connection.execute("SELECT 1 FROM todos WHERE id=?", (todo_id,)).fetchone():
            raise HTTPException(404, "待办不存在")
    from .. import task_planner
    try:
        return {"ok": True, 'task': task_planner.save(todo_id=todo_id, **payload.model_dump(exclude_none=True))}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/poll")
def api_poll():
    def _run():
        try:
            pipeline.poll_once()
        except Exception:
            log.exception("手动拉取失败")
    start_account_thread(_run, name="mailai-manual-poll")
    return {"ok": True, "msg": "已开始拉取"}


@app.post("/api/fetch_more")
def api_fetch_more(limit: int = 20):
    def _run():
        try:
            pipeline.fetch_more(limit=limit)
        except Exception:
            log.exception("拉取更多历史邮件失败")
    start_account_thread(_run, name="mailai-fetch-more")
    return {"ok": True, "msg": "已开始拉取更多历史邮件"}


@app.post("/api/fetch_all")
def api_fetch_all():
    def _run():
        try:
            _complete_mailbox_initialization()
        except Exception:
            log.exception("拉取全部历史邮件失败")
    start_account_thread(_run, name="mailai-fetch-all")
    return {"ok": True, "msg": "已开始完整同步收件箱、已发送、草稿和自定义文件夹，请稍后刷新"}


@app.get("/api/digest")
def api_digest():
    text = pipeline.today_digest()
    if not text:
        raise HTTPException(503, "LLM 未配置或今天没有可分析的邮件")
    # 保存日报历史，同一天多次生成则保留最新一次（先删后插）
    today = datetime.now().strftime("%Y-%m-%d")
    with db.conn() as c:
        c.execute("DELETE FROM digest_history WHERE digest_date=?", (today,))
    db.save_digest(text, today)
    return {"digest": text}


@app.get("/api/digests")
def api_digests(limit: int = 30):
    return db.list_digests(limit)


@app.get("/api/digests/{digest_id}")
def api_digest_detail(digest_id: int):
    row = db.get_digest(digest_id)
    if not row:
        raise HTTPException(404, "日报不存在")
    return row


@app.get("/api/health")
def api_health():
    return {
        "imap_configured": bool(config.IMAP_PASSWORD),
        "llm_configured": bool(config.LLM_API_KEY),
        "llm_model": config.LLM_MODEL,
        "poll_interval": config.POLL_INTERVAL_SECONDS,
    }


@app.get("/api/weekly_report")
def api_weekly_report():
    stats = db.stats_range(days=7)
    lines = [
        "## 本周邮件安全周报",
        f"- 总处理邮件：**{stats['total']}** 封",
        f"- 钓鱼邮件：**{stats['phishing']}** 封",
        f"- 可疑邮件：**{stats['suspicious']}** 封",
        f"- 垃圾邮件：**{stats['spam']}** 封",
        f"- 已隔离：**{stats['quarantine']}** 封",
        f"- 误报：**{stats['false_positives']}** 封",
        f"- 漏报：**{stats['false_negatives']}** 封",
        f"- 估算节省人工审核时间：**{stats['saved_hours']}** 小时",
    ]
    top = db.sender_risk_top(5)
    if top:
        lines.append("\n### 高风险发件人 TOP5")
        for p in top:
            lines.append(f"- {p['sender_key']}（风险分 {p['risk_score']}，邮件数 {p['message_count']}）")
    return {"report": "\n".join(lines)}


@app.get("/api/fetch_status")
def api_fetch_status():
    return pipeline.get_fetch_state()


@app.post("/api/cancel_fetch")
def api_cancel_fetch():
    pipeline.cancel_fetch()
    return {"ok": True, "msg": "已请求取消拉取"}
