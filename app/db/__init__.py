"""SQLite 存储层（兼容入口）。按领域拆分为子模块，此处统一再导出。

所有调用方继续使用 `from . import db` + `db.xxx`，无需修改。
"""
from .core import (
    SCHEMA,
    conn,
    init_db,
    _run_migrations,
)
from .sync import (
    save_sync_job,
    get_sync_job,
    get_last_uid,
    get_uid_validity,
    observe_uid_validity,
    get_first_uid,
    set_last_uid,
)
from .emails import (
    upsert_email,
    already_processed,
    finish_email_processing,
    claim_mail_notification,
    count_history_imported,
    folder_uids,
    EMAIL_LIST_COLUMNS,
    list_emails,
    iter_emails,
    notification_candidates,
    mailbox_revision,
    search_emails,
    list_correspondence_emails,
    list_attachments,
    list_inline_attachment_candidates,
    update_attachment_metadata,
    get_email,
    _decode_rows,
    get_email_by_folder_uid,
    list_special_folder_emails,
    set_status,
    reconcile_folder,
    set_remote_missing,
    set_mail_state,
    sync_mail_flags,
    set_reviewed,
    update_llm,
    frequent_sender_domains,
    record_feedback,
)
from .trash import (
    queue_trash,
    due_trash_actions,
    discard_exhausted_trash_actions,
    advance_trash_action,
    retry_trash_action,
    finish_trash_action,
    cancel_pending_trash,
)
from .seen import (
    queue_seen_sync,
    due_seen_sync_jobs,
    finish_seen_sync,
    retry_seen_sync,
)
from .drafts import (
    save_draft,
    list_drafts,
    get_draft,
    complete_sent_draft,
    delete_draft,
    create_sent_message,
    finish_sent_message,
    list_sent_messages,
    get_sent_message,
    get_sent_attachment,
)
from .assistant import (
    get_ai_analysis_cache,
    save_ai_analysis_cache,
    create_assistant_conversation,
    set_assistant_alert_context,
    assistant_alert_context,
    add_assistant_message,
    list_assistant_conversations,
    get_assistant_messages,
    get_assistant_image,
    assistant_conversation_exists,
)
from .contacts import (
    contact_display_names,
    search_contacts,
    save_contact,
    set_contact_favorite,
    hide_contact,
    contact_history,
    list_contact_groups,
    save_contact_group,
    delete_contact_group,
    update_contact_group_members,
)
from .todos import (
    add_todos,
    list_todos,
    set_todo_status,
    set_todos_status,
    update_todo,
    refresh_generated_todos,
    delete_todos_of,
)
from .threads import (
    upsert_thread,
    get_thread,
    list_thread_emails,
    get_or_create_sender_profile,
    update_sender_profile,
    sender_risk_top,
)
from .audit import (
    add_audit_log,
    list_audit_logs,
    audit_action_exists,
    list_auto_action_candidates,
)
from .settings import (
    list_rule_settings,
    set_rule_setting,
    delete_rule_settings,
    list_security_allowlist,
    upsert_security_allowlist,
    delete_security_allowlist,
    upsert_security_allowlist_address,
    delete_security_allowlist_address,
    set_rule_settings,
    get_runtime_settings,
    set_runtime_setting,
)
from .chains import (
    save_url_chain,
    get_url_chains,
)
from .metrics import (
    stats_today,
    stats_range,
    daily_trend,
    dashboard_operations,
)
from .digests import (
    save_digest,
    list_digests,
    get_digest,
)
