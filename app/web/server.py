"""FastAPI 应用组装：中间件、静态资源、启动钩子与路由挂载。

接口实现已按域拆分到 app/web/routes/，请求模型在 app/web/schemas.py，
共享辅助函数在 app/web/helpers.py。本文件保留原有公开名称作为兼容层，
测试与外部调用方仍可 `from app.web.server import api_xxx / XxxRequest`。
"""
import logging
import os
import json

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .. import config, db, pipeline, system_settings
from .. import smtp_client, outgoing_guard  # noqa: F401  供测试 patch server.smtp_client / server.outgoing_guard
from ..imap_client import MailClient, mailbox_role  # noqa: F401  供测试 patch server.MailClient
from ..account_guard import AccountGuardMiddleware, start_account_thread
from . import helpers
from .origin_guard import LocalOriginMiddleware
from .schemas import *  # noqa: F401,F403  请求模型兼容再导出
from .schemas import (AccountSwitchRequest, AllowlistRequest, AssistantAttachmentRef,
                      AssistantImage, AssistantRequest, BulkMailRequest,
                      CleanupExecuteRequest, CleanupPreviewRequest, ComposeAssistRequest,
                      ContactFavoriteRequest, ContactGroupMembersRequest, ContactGroupRequest,
                      ContactRequest, DraftRequest, FolderRequest, MailAccountUpdateRequest,
                      MailLoginRequest, MailLogoutRequest, MailPreflightRequest,
                      ModelConfigRequest, PortableExportRequest, PortableImportRequest,
                      PreferencesRequest, QueuedMailRequest, RuleCategoryRequest,
                      SendMailRequest, SignatureGenerateRequest, SignatureRequest,
                      TodoBulkStatusRequest, TodoUpdateRequest)

log = logging.getLogger(__name__)

app = FastAPI(title="MailAI", docs_url=None, redoc_url=None)
app.add_middleware(AccountGuardMiddleware)
app.add_middleware(LocalOriginMiddleware)
_STATIC = os.path.join(os.path.dirname(__file__), "static")

app.mount("/static", StaticFiles(directory=_STATIC), name="static")


@app.on_event("startup")
def startup_init():
    db.init_db()
    system_settings.initialize_current_account()
    job = db.get_sync_job()
    if config.IMAP_USER and config.IMAP_PASSWORD:
        start_account_thread(pipeline.repair_local_mail_data,
                             name="mailai-repair-local-data")
        account_id = system_settings._account_key(config.IMAP_HOST, config.IMAP_USER)
        account = system_settings._load_registry().get("accounts", {}).get(account_id, {})
        if job and job.get("status") in ("running", "pending", "failed") and not account.get("auto_sync_paused", False):
            start_account_thread(helpers.complete_mailbox_initialization, name="mailai-resume-sync")


@app.get("/")
def index():
    # 页面结构与脚本必须同版本，避免升级后浏览器复用旧 HTML 导致新增控件缺失。
    return FileResponse(os.path.join(_STATIC, "index.html"), headers={"Cache-Control": "no-store"})


@app.get("/api/health")
def api_health():
    return {
        "imap_configured": bool(config.IMAP_PASSWORD),
        "llm_configured": bool(config.LLM_API_KEY),
        "llm_model": config.LLM_MODEL,
        "poll_interval": config.POLL_INTERVAL_SECONDS,
    }


@app.get("/api/ui-preferences.js")
def ui_preferences_bootstrap():
    from ..ui_preferences import load
    return Response("window.mailaiPreferenceSeed=" + json.dumps(load(), ensure_ascii=True) + ";",
                    media_type="application/javascript")


@app.post("/api/ui-preferences")
def save_ui_preference(payload: dict):
    from ..ui_preferences import save
    try:
        save(payload.get("key"), payload.get("value"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"ok": True}


from .routes import assistant, compose, contacts, mail_actions, mail_read, reports, security, sync, system, todos

for _router_module in (system, security, reports, sync, mail_read,
                       mail_actions, compose, contacts, assistant, todos):
    app.include_router(_router_module.router)


# ---------- 兼容层：旧 server.py 的公开名称 ----------
_campaign_groups = helpers.campaign_groups
_complete_mailbox_initialization = helpers.complete_mailbox_initialization
_mail_connection_detail = helpers.mail_connection_detail
_resolved_contact_name = helpers.resolved_contact_name
_annotate_list_identity = helpers.annotate_list_identity
_annotate_list_identities = helpers.annotate_list_identities
_valid_contact_email = helpers.valid_contact_email
_prepare_assistant_images = helpers.prepare_assistant_images
_prepare_assistant_materials = helpers.prepare_assistant_materials
_correspondence_payload = helpers.correspondence_payload

from .routes.system import (
    api_backups,
    api_cleanup_execute,
    api_cleanup_history,
    api_cleanup_preview,
    api_create_backup,
    api_create_portable_backup,
    api_delete_backup,
    api_delete_portable_backup,
    api_discard_portable_backup,
    api_download_backup,
    api_download_portable_backup,
    api_inspect_portable_backup,
    api_mail_account_update,
    api_mail_discover,
    api_mail_login,
    api_mail_logout,
    api_mail_preferred,
    api_mail_switch,
    api_model_config,
    api_model_test,
    api_portable_backups,
    api_preferences,
    api_restore_backup,
    api_restore_portable_backup,
    api_save_preferences,
    api_system_config,
    api_system_diagnostics,
    api_system_update,
    api_system_update_install,
    api_system_update_install_status,
    api_unified_inbox,
)
from .routes.security import (
    api_action_policy,
    api_delete_allowlist,
    api_delete_allowlist_typed,
    api_reset_rules,
    api_rules,
    api_save_allowlist,
    api_security_campaigns,
    api_set_action_policy,
    api_update_rule,
    api_update_rule_category,
    api_update_thresholds,
)
from .routes.reports import (
    api_dashboard,
    api_digest,
    api_digest_detail,
    api_digests,
    api_stats,
    api_weekly_report,
)
from .routes.sync import (
    api_cancel_fetch,
    api_create_mail_folder,
    api_delete_mail_folder,
    api_fetch_all,
    api_fetch_more,
    api_fetch_status,
    api_mail_folders,
    api_poll,
    api_sync_mail_folder,
)
from .routes.mail_read import (
    api_attachments,
    api_download_attachment,
    api_email_detail,
    api_emails,
    api_inline_resource,
    api_mailbox_revision,
    api_preview_attachment,
    api_search_emails,
    api_sender_profile,
)
from .routes.mail_actions import (
    api_bulk_email_action,
    api_confirm,
    api_email_audit,
    api_email_correspondence,
    api_email_thread,
    api_feedback,
    api_move_email,
    api_reply_recipients,
    api_restore,
    api_rollback_recent,
    api_set_email_favorite,
    api_set_email_read,
    api_set_email_star,
    api_undo_mail,
)
from .routes.compose import (
    api_cancel_outbox,
    api_compose_assist,
    api_default_mail_signature,
    api_delete_draft,
    api_delete_mail_signature,
    api_download_draft_attachment,
    api_download_sent_attachment,
    api_draft,
    api_drafts,
    api_generate_mail_signature,
    api_mail_preflight,
    api_mail_signatures,
    api_outbox,
    api_preview_draft_attachment,
    api_preview_sent_attachment,
    api_queue_mail,
    api_resolve_outbox,
    api_save_draft,
    api_save_mail_signature,
    api_send_capability,
    api_send_mail,
    api_sent_message,
    api_sent_messages,
)
from .routes.contacts import (
    api_contact_correspondence,
    api_contact_group_members,
    api_contact_groups,
    api_delete_contact,
    api_delete_contact_group,
    api_favorite_contact,
    api_mail_contacts,
    api_save_contact,
    api_save_contact_group,
)
from .routes.assistant import (
    api_assistant_alerts,
    api_assistant_alerts_seen,
    api_assistant_ask,
    api_assistant_ask_stream,
    api_assistant_attachment_catalog,
    api_assistant_attachment_preview,
    api_assistant_briefing,
    api_assistant_conversation,
    api_assistant_conversations,
    api_assistant_image,
    api_briefing_dismiss,
    api_briefing_restore,
)
from .routes.todos import (
    api_all_reminders,
    api_dismiss_reminder,
    api_dismiss_task_reminder,
    api_email_todo,
    api_remind_email,
    api_reminders,
    api_todo_done,
    api_todo_reopen,
    api_todo_update,
    api_todos,
    api_todos_bulk_status,
)
