"""Offline release gate. Explicit allowlist excludes live email/model tests.

Run with the same Python environment used to build the application.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Some Windows terminals still expose GBK to Python after `chcp 65001`.
os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"
release_temp = ROOT / "build" / "release-temp"
release_temp.mkdir(parents=True, exist_ok=True)
os.environ.update(TEMP=str(release_temp), TMP=str(release_temp), TMPDIR=str(release_temp))
for stream in (sys.stdout, sys.stderr):
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure:
        reconfigure(encoding="utf-8", errors="backslashreplace")
TESTS = (
    'test_model_providers.py',
    'test_live_diagnostics.py',
    'test_optimization_guards.py', 'test_interaction_fixes.py', 'test_pinyin_search.py',
    'test_resource_safety.py',
    'test_mail_arrival_lifecycle.py',
    'test_maturity_hardening.py',
    'test_portable_backup.py',
    'test_release_hardening.py',
    'test_document_preview.py', 'test_spreadsheet_preview.py', 'test_attachment_preview.py', 'test_inline_attachments.py', 'test_multimodal.py', 'test_server_folder_preference.py',
    'test_assistant_attachments.py',
    'test_assistant_images.py',
    'test_task_planner.py',
    'test_secretary.py',
    'test_sync_attention_state.py',
    'test_workspace_maturity.py',
    'test_action_policy.py', 'test_rule_policy.py', 'test_retired_security_signals.py', 'test_mail_providers.py',
    'test_mail_reliability.py', 'test_client_regressions.py', 'test_safe_move.py',
    'test_batch_move.py',
    'test_confirm_recovery.py',
    'test_feedback_moves.py', 'test_account_guard.py', 'test_reply_recipients.py',
    'test_draft_thread.py', 'test_draft_lifecycle.py', 'test_folder_safety.py', 'test_sync_retry.py', 'test_system_settings.py',
    'test_email_identity.py',
    'test_assistant_routing.py',
    'test_send_outcome.py',
    'test_desktop_shell.py',
    'test_mail_navigation.py',
    'test_windows_shell.py', 'test_windows_upgrade.py', 'test_release_update.py',
    'test_windows_startup_probe.py',
    'test_inno_setup_discovery.py',
    'test_runtime_logging.py',
    'test_isolated_startup.py',
    'test_mail_date_semantics.py',
    'test_history_ai_budget.py',
    'test_async_seen_sync.py',
    'test_folder_sync.py', 'test_spam_folder_routing.py',
    'test_encoding_safety.py',
    'test_release_encoding.py',
    'test_finding_presentation.py',
    'test_todo_order.py',
    'test_thread_context.py',
    'test_correspondence.py',
    'test_bulk_trash.py',
    'test_thread_guard.py',
    'test_campaigns.py',
    'test_outgoing_guard.py',
    'test_preflight_gate.py',
    'test_signatures.py',
    'test_contacts.py', 'test_contact_identity.py', 'test_contact_name_ordering.py', 'test_sent_attachments.py', 'test_compose_file_tools.py', 'test_draft_completion_integrity.py',
    'test_mail_library.py',
    'test_chain_worker.py',
    'test_ioc_export.py',
    'test_feedback_analysis.py',
    'test_export_corpus.py',
    'test_assistant_actions.py',
    'test_ollama_preset.py',
    'test_semantic_search.py',
    'test_linux_appimage.py',
    'test_server_cleanup.py',
)


def main():
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js is required for frontend release checks')
    commands = [[sys.executable, str(ROOT / 'tests' / name)] for name in TESTS]
    commands.append([sys.executable, str(ROOT / 'scripts/build_frontend.py'), '--check'])
    commands.append([sys.executable, str(ROOT / 'tests/evaluate.py'), '--gate'])
    commands.append([node, '--check', str(ROOT / 'app/web/static/bundle.js')])
    if sys.platform == 'darwin':
        commands.append([sys.executable, str(ROOT / 'tests/test_mail_links_webkit.py')])
    commands += [[node, '--check', str(ROOT / 'app/web/static/server-cleanup.js')]]
    commands += [[node, '--check', str(ROOT / 'app/web/static/i18n.js')]]
    commands += [[node, str(ROOT / 'tests/test_i18n.cjs')]]
    commands += [[node, '--check', str(ROOT / 'app/web/static/onboarding.js')]]
    commands += [[node, '--check', str(ROOT / 'app/web/static/mail-library.js')]]
    commands += [[node, '--check', str(ROOT / 'app/web/static/attachment-preview.js')]]
    commands += [[node, '--check', str(ROOT / 'app/web/static/app.js')],
                 [node, str(ROOT / 'tests/test_interaction_fixes.cjs')],
                 [node, str(ROOT / 'tests/test_trash_navigation.cjs')],
                 [node, str(ROOT / 'tests/test_async_ui_safety.cjs')],
                 [node, str(ROOT / 'tests/test_digest_races.cjs')],
                 [node, '--check', str(ROOT / 'app/web/static/assistant-images.js')],
                 [node, '--check', str(ROOT / 'app/web/static/assistant-attachments.js')],
                 [node, '--check', str(ROOT / 'app/web/static/secretary.js')],
                 [node, '--check', str(ROOT / 'app/web/static/task-planner.js')],
                 [node, str(ROOT / 'tests/test_sync_attention_ui.cjs')],
                 [node, str(ROOT / 'tests/test_transient_workspace_notice.cjs')],
                 [node, str(ROOT / 'tests/test_assistant_sources.cjs')],
                 [node, '--check', str(ROOT / 'app/web/static/workspace.js')],
                 [node, '--check', str(ROOT / 'app/web/static/companion.js')],
                 [node, '--check', str(ROOT / 'app/web/static/companion-motion.js')],
                 [node, str(ROOT / 'tests/test_workspace_polish.cjs')],
                 [node, str(ROOT / 'tests/test_rule_center_ui.cjs')],
                 [node, str(ROOT / 'tests/test_settings_preferences.cjs')],
                 [node, str(ROOT / 'tests/test_account_settings_ui.cjs')],
                 [node, str(ROOT / 'tests/test_settings_unified_ui.cjs')],
                 [node, str(ROOT / 'tests/test_sync_progress_ui.cjs')],
                 [node, str(ROOT / 'tests/test_low_end_ui.cjs')],
                 [node, str(ROOT / 'tests/test_sent_read_state.cjs')],
                 [node, str(ROOT / 'tests/test_draft_queue.cjs')],
                 [node, str(ROOT / 'tests/test_mail_pages.cjs')],
                 [node, str(ROOT / 'tests/test_loading_buttons.cjs')],
                 [node, str(ROOT / 'tests/test_reading_context.cjs')],
                 [node, str(ROOT / 'tests/test_reading_header_ui.cjs')],
                 [node, str(ROOT / 'tests/test_review_actions.cjs')],
                 [node, str(ROOT / 'tests/test_assistant_ui.cjs')],
                 [node, str(ROOT / 'tests/test_assistant_actions.cjs')],
                 [node, str(ROOT / 'tests/test_semantic_toggle.cjs')],
                 [node, str(ROOT / 'tests/test_assistant_markdown.cjs')],
                 [node, str(ROOT / 'tests/test_xiaoyou_brand.cjs')],
                 [node, str(ROOT / 'tests/test_summary_display.cjs')],
                 [node, str(ROOT / 'tests/test_correspondence_ui.cjs')],
                 [node, str(ROOT / 'tests/test_correspondence_selection.cjs')],
                 [node, str(ROOT / 'tests/test_settings_information_architecture.cjs')],
                 [node, str(ROOT / 'tests/test_contact_center.cjs')],
                 [node, str(ROOT / 'tests/test_mail_filters.cjs')],
                 [node, str(ROOT / 'tests/test_select_ui.cjs')],
                 [node, str(ROOT / 'tests/test_onboarding_state.cjs')],
                 [node, str(ROOT / 'tests/test_mail_range_selection.cjs')],
                 [node, str(ROOT / 'tests/test_risk_labels.cjs')],
                 [node, str(ROOT / 'tests/test_remote_images.cjs')],
                 [node, str(ROOT / 'tests/test_dark_theme_palette.cjs')],
                 [node, str(ROOT / 'tests/test_dark_dialog_surfaces.cjs')],
                 [node, str(ROOT / 'tests/test_ui_refinement.cjs')],
                 [node, str(ROOT / 'tests/test_model_privacy_ui.cjs')]]
    failures = []
    for command in commands:
        label = Path(command[-1]).name
        try:
            result = subprocess.run(
                command, cwd=ROOT, capture_output=True, text=True, timeout=90,
                env=os.environ.copy(), encoding="utf-8", errors="replace",
            )
            if result.returncode:
                failures.append(label)
                print(f'FAIL {label}\n{result.stdout}\n{result.stderr}', flush=True)
            else:
                print(f'PASS {label}', flush=True)
        except subprocess.TimeoutExpired:
            failures.append(label)
            print(f'TIMEOUT {label}', flush=True)
    print(f'Offline release checks: {len(commands) - len(failures)}/{len(commands)} passed')
    if failures:
        print(f'Failed checks: {", ".join(failures)}', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
