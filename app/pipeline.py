"""主管道：拉取 → 规则检测 → 上下文/行为/LLM 复核 → 处置（隔离/垃圾）→ 入库 → 审计。"""
import logging
import json
import copy
import os
import re
import threading
import time
from datetime import datetime, timezone

from . import config, db, parser, profiles, threads
from .imap_client import MailClient, RawMessageBatch, mailbox_role
from .account_guard import account_work
from .llm import analyze as llm_analyze
from .llm import client as llm_client
from .llm import multimodal
from .security import attachments, chains, chain_worker, rules, policy, thread_guard

log = logging.getLogger(__name__)

class _MailboxLock:
    def __init__(self):
        self.locks = {}
        self.guard = threading.Lock()

    def _current(self):
        with self.guard:
            return self.locks.setdefault(config.DB_PATH, threading.Lock())

    def acquire(self, blocking=True):
        return self._current().acquire(blocking=blocking)

    def release(self):
        self._current().release()


_poll_lock = _MailboxLock()
SPAM_RULE_THRESHOLD = 25  # 无 LLM 时，垃圾营销规则分阈值

# 拉取进度状态（供前端轮询）
_fetch_state_lock = threading.Lock()
_fetch_state = {
    "running": False,
    "operation": "",  # poll / fetch_more / fetch_all
    "total": 0,
    "processed": 0,
    "message": "",
    "error": "",
    "canceled": False,
    "phase": "idle",
}
_fetch_cancel = False
_account_fetch_states = {}
_account_cancellations = {}
_action_policy_lock = threading.Lock()
_runtime_action_mode = config.ACTION_MODE
_account_action_modes = {}
_action_guard = {"moved": 0, "blocked": 0, "tripped": False}
_account_action_guards = {}
_MAX_FOLDER_PROGRESS = 100


def _saved_action_mode() -> str:
    mode = _account_action_modes.get(config.DB_PATH)
    if mode not in ("observe", "review", "auto"):
        try:
            mode = db.get_runtime_settings().get("action_mode", config.ACTION_MODE)
        except Exception:
            mode = config.ACTION_MODE
        if mode not in ("observe", "review", "auto"):
            mode = "observe"
        _account_action_modes[config.DB_PATH] = mode
    return mode


def _ordered_history_uids(uids) -> list[int]:
    """IMAP UIDs are normally chronological; import newest mail first."""
    return sorted((int(uid) for uid in uids), reverse=True)


def _history_ai_allowed(email: dict, history_rank: int | None) -> bool:
    """Bound productivity/visual AI for backlog while keeping new mail real-time."""
    if history_rank is None:
        return True
    if config.HISTORY_AI_LIMIT <= 0 or history_rank > config.HISTORY_AI_LIMIT:
        return False
    if config.HISTORY_AI_DAYS <= 0:
        return False
    value = str(email.get("date") or "").strip()
    if not value:
        return False
    try:
        received = datetime.fromisoformat(value.replace("Z", "+00:00"))
        now = datetime.now(received.tzinfo or timezone.utc)
        if received.tzinfo is None:
            now = now.replace(tzinfo=None)
        age_days = max(0.0, (now - received).total_seconds() / 86400)
        return age_days <= config.HISTORY_AI_DAYS
    except (TypeError, ValueError, OverflowError):
        return False


def _current_action_guard():
    from .account_context import current
    if current.get() is None:
        return _action_guard
    return _account_action_guards.setdefault(config.DB_PATH, {"moved": 0, "blocked": 0, "tripped": False})


def get_action_policy() -> dict:
    mode = _saved_action_mode()
    with _action_policy_lock:
        return {
            "mode": mode,
            "max_per_run": config.AUTO_ACTION_MAX_PER_RUN,
            **_current_action_guard(),
        }


def set_action_mode(mode: str) -> dict:
    if mode not in ("observe", "review", "auto"):
        raise ValueError("mode 必须是 observe、review 或 auto")
    global _runtime_action_mode
    db.set_runtime_setting("action_mode", mode)
    with _action_policy_lock:
        _runtime_action_mode = mode
        _account_action_modes[config.DB_PATH] = mode
    db.add_audit_log(None, action="policy_change", actor="user",
                     reason=f"处置模式切换为 {mode}", meta={"mode": mode})
    return get_action_policy()


def _reset_action_guard():
    with _action_policy_lock:
        _current_action_guard().update(moved=0, blocked=0, tripped=False)


def _resolve_action(recommended_status: str) -> tuple[str, bool, str]:
    """将检测建议转换成实际动作；返回 (实际状态, 是否移动, 原因)。"""
    if recommended_status == "inbox":
        return "inbox", False, "无需处置"
    mode = _saved_action_mode()
    with _action_policy_lock:
        action_guard = _current_action_guard()
        if mode == "observe":
            return "inbox", False, "观察模式：仅记录处置建议"
        if mode == "review":
            return "inbox", False, "人工确认模式：等待用户确认"
        if action_guard["moved"] >= config.AUTO_ACTION_MAX_PER_RUN:
            action_guard["blocked"] += 1
            action_guard["tripped"] = True
            return "inbox", False, "自动处置熔断：达到单次移动上限"
        action_guard["moved"] += 1
        return recommended_status, True, "自动处置模式：满足移动条件"


def _set_fetch_state(running: bool, operation: str = "", total: int = 0,
                     processed: int = 0, message: str = "", error: str = "",
                     canceled: bool = False, folder_progress=None,
                     current_folder: str = "", folder_omitted: int = 0,
                     persist: bool = True):
    global _fetch_state
    if not running:
        phase = "completed" if not error and not canceled else "paused"
    elif not total:
        phase = "scanning"
    elif processed < total:
        phase = "analyzing"
    else:
        phase = "finalizing"
    with _fetch_state_lock:
        previous = _account_fetch_states.get(config.DB_PATH, {})
        now = time.monotonic()
        _fetch_state = {
            "running": running,
            "operation": operation,
            "total": total,
            "processed": processed,
            "message": message,
            "error": error,
            "canceled": canceled,
            "phase": phase,
            "folder_progress": copy.deepcopy(
                (folder_progress if folder_progress is not None else previous.get("folder_progress", []))
                [: _MAX_FOLDER_PROGRESS]
            ),
            "current_folder": current_folder,
            "folder_omitted": max(0, int(folder_omitted or 0)),
            "started_at": previous.get("started_at", now) if previous.get("running") else now,
            "updated_at": now,
        }
        _account_fetch_states[config.DB_PATH] = dict(_fetch_state)
    # 同步状态写入数据库，进程退出后仍可判断是否需要续传。
    if persist:
        try:
            db.save_sync_job(operation or "fetch_all", status="running" if running else
                             ("canceled" if canceled else "failed" if error else "completed"),
                             total=total, processed=processed, message=message, error=error)
        except Exception:
            log.exception("保存同步任务状态失败")


def get_live_fetch_state(db_path=None):
    """Process-local truth, explicitly scoped without activating another account."""
    with _fetch_state_lock:
        state = dict(_account_fetch_states.get(db_path or config.DB_PATH, {
            "running": False, "operation": "", "total": 0, "processed": 0,
            "message": "", "error": "", "canceled": False, "phase": "idle",
            "folder_progress": [], "current_folder": "", "folder_omitted": 0}))
        state["folder_progress"] = copy.deepcopy(state.get("folder_progress") or [])
    now = time.monotonic()
    state['elapsed_seconds'] = int(max(0, now - state.pop('started_at', now)))
    state['quiet_seconds'] = int(max(0, now - state.pop('updated_at', now)))
    if not state['running']:
        state.update(elapsed_seconds=0, quiet_seconds=0)
    return state


def get_fetch_state():
    state = get_live_fetch_state()
    if not state["running"]:
        persisted = db.get_sync_job()
        if persisted and persisted.get("status") in ("running", "pending", "failed", "canceled"):
            state.update({
                "operation": persisted.get("operation") or "fetch_all",
                "total": persisted.get("total") or 0,
                "processed": persisted.get("processed") or 0,
                "message": "上次同步中断，可重新同步" if persisted.get("status") in ("running", "pending") else persisted.get("message") or "历史邮件尚未同步完成",
                "error": persisted.get("error") or "",
                "resumable": True,
            })
    return state


def is_fetch_running() -> bool:
    """只读取内存状态，账号切换/清空存储时不触碰当前数据库。"""
    with _fetch_state_lock:
        return any(state.get("running") for state in _account_fetch_states.values())


def cancel_fetch():
    global _fetch_cancel
    st = get_live_fetch_state()
    if not st['running']:
        return
    _fetch_cancel = True
    _account_cancellations[config.DB_PATH] = True
    # Do not recreate a running job if its worker finishes during cancellation.
    with _fetch_state_lock:
        state = _account_fetch_states.get(config.DB_PATH)
        if state and state['running']:
            state.update(canceled=True, message="正在取消，等待当前步骤结束…")


def _reset_cancel():
    global _fetch_cancel
    _fetch_cancel = False
    _account_cancellations[config.DB_PATH] = False


def _is_canceled():
    return _account_cancellations.get(config.DB_PATH, False)


def _rule_summary(scan: dict) -> str:
    parts = [f"{f['code']}({f['detail']})" for f in scan["findings"][:8]]
    return f"规则分 {scan['score']}/100: " + ("; ".join(parts) if parts else "无命中")


def _analyze_url_chains(email: dict) -> tuple[list, list]:
    """对可疑 URL 跟踪跳转链，返回 (findings, chain_results)。

    跟踪在子进程中执行（chain_worker），目标 URL 由邮件内容控制，
    防止慢响应/挂起拖垮主处理管道。
    """
    findings = []
    chain_results = []
    if not email.get("urls"):
        return findings, chain_results
    urls = [u for u in email["urls"][:5] if chains.is_suspicious_for_chain(u)]
    if not urls:
        return findings, chain_results
    for item in chain_worker.analyze_urls(urls, email.get("body_html", "")):
        findings.extend(item.get("findings") or [])
        if item.get("result"):
            chain_results.append(item["result"])
    return findings, chain_results


def _analyze_attachments(email: dict) -> tuple[list, list]:
    """对附件做静态分析，返回 (findings, analysis_results)。"""
    results = attachments.analyze_all_attachments(email)
    findings = []
    for r in results:
        findings.extend(r.get("findings", []))
    return findings, results


def process_message(mail: MailClient, uid: int, raw: bytes,
                    history_rank: int | None = None, *, arrival_kind=None) -> dict:
    arrival_kind = arrival_kind or ('new' if _account_fetch_states.get(config.DB_PATH, {}).get('operation') == 'poll' else 'history')
    if arrival_kind == 'new' and 'assistant_attention_state' not in db.get_runtime_settings():
        from . import mail_assistant
        mail_assistant.alerts()
    email = parser.parse_message(uid, raw)
    allow_history_ai = _history_ai_allowed(email, history_rank)
    thread_history = db.list_thread_emails(email.get("thread_id"), limit=8) if email.get("thread_id") else []

    # 1) 发件人画像更新（必须在规则扫描前，因为规则会用到 profile 异常）
    profile = profiles.update_profile_from_email(email)

    # 2) 规则扫描（含行为基线异常）
    scan = rules.scan(email)

    # 3) URL 链路与附件深度分析。历史首次导入可能有数千封邮件：全部做
    # 解压、文档解析和网络跳转检查会长期占用 CPU/磁盘。最新一段历史完整
    # 检查；更早邮件先走快速规则，规则已命中风险时仍自动升级为深度检查。
    deep_history = (
        history_rank is None
        or history_rank <= config.HISTORY_DEEP_SCAN_LIMIT
        or scan["score"] >= config.LLM_REVIEW_SCORE
    )
    url_findings, url_chain_results = _analyze_url_chains(email) if deep_history else ([], [])
    att_findings, att_analysis_results = _analyze_attachments(email) if deep_history else ([], [])
    # New/recent mail gets visual review. Old backlog only uses it when cheap
    # local evidence has already crossed the review threshold.
    visual_review = multimodal.analyze_images(email) \
        if allow_history_ai or scan["score"] >= config.LLM_REVIEW_SCORE else None
    visual_findings = multimodal.to_findings(visual_review)
    if visual_review:
        att_analysis_results.append({"type": "multimodal_visual_review", **visual_review})
    scan["findings"].extend(url_findings)
    scan["findings"].extend(att_findings)
    scan["findings"].extend(visual_findings)
    scan["findings"].extend(thread_guard.detect(email, thread_history))
    scan["findings"] = policy.apply(scan["findings"])
    scan["spam_findings"] = policy.apply(scan["spam_findings"])
    scan["findings"] = policy.apply_allowlist(scan["findings"], scan.get("allowlist"))
    if scan.get("allowlist"):
        scan["spam_findings"] = []
    scan["score"] = min(100, sum(f["weight"] for f in scan["findings"]))
    # 重新判定 verdict
    limits = policy.thresholds()
    scan["verdict"] = "phishing" if scan["score"] >= limits["quarantine_score"] else (
        "suspicious" if scan["score"] >= limits["review_score"] else "clean")

    verdict = scan["verdict"]
    status = "inbox"
    llm_phishing, llm_reasons = None, []
    review_source = "rule"

    # 4) 多轮上下文：获取 thread summary
    thread_summary = threads.get_thread_summary(email.get("thread_id"))

    # 5) LLM 安全复核
    if scan["score"] >= config.LLM_REVIEW_SCORE and llm_client.available():
        review = llm_analyze.security_review(email, _rule_summary(scan), thread_summary)
        if review:
            llm_phishing = 1 if review["phishing"] else 0
            llm_reasons = review["reasons"] + review["evidence"]
            review_source = "llm"
            if review["phishing"] and review["confidence"] >= 0.6:
                verdict = "phishing"
            elif not review["phishing"] and review["confidence"] >= 0.8 \
                    and verdict == "suspicious":
                verdict = "clean"
            if review["is_spam"] and not review["phishing"]:
                status = "spam"

    # 6) 无 LLM 或 LLM 未判垃圾时的纯规则垃圾判定
    if status == "inbox" and verdict == "clean" and scan["spam_score"] >= limits["spam_score"]:
        status = "spam"

    # 7) 钓鱼 → 隔离
    if verdict == "phishing":
        status = "quarantine"

    recommended_status = status
    actual_status, action_taken, action_reason = _resolve_action(recommended_status)

    # 8) 工作分析（仅建议留在收件箱的邮件；省钱模式跳过营销特征明显的）
    analysis = None
    if recommended_status == "inbox" and allow_history_ai and llm_client.available():
        if config.LLM_ANALYZE_ALL or scan["spam_score"] < 15:
            analysis = llm_analyze.work_analysis(email)

    # 9) 提取最终落地域/IP（取第一个 URL 链结果）
    final_domain = url_chain_results[0].get("final_domain") if url_chain_results else None
    final_ip = url_chain_results[0].get("final_ip") if url_chain_results else None

    # 10) 入库
    record = {
        'arrival_kind': arrival_kind,
        "uid": uid,
        "folder": config.INBOX_FOLDER,
        "message_id": email["message_id"],
        "in_reply_to": email.get("in_reply_to"),
        "references_header": email.get("references_header"),
        "thread_id": email.get("thread_id"),
        "sender_profile_id": profile.get("id") if profile else None,
        "subject": email["subject"],
        "from_addr": email["from_addr"],
        "from_name": email["from_name"],
        "to_addr": email["to_addr"],
        "cc_addr": email.get("cc_addr", ""),
        "recipient_names": email.get("recipient_names") or {},
        "date": email["date"],
        "snippet": email["snippet"],
        "body_text": email["body_text"],
        "urls": email["urls"],
        "attachments": email["attachments"],
        "attachment_analysis": att_analysis_results,
        "auth": scan["auth"],
        "score": scan["score"],
        "verdict": verdict,
        "findings": scan["findings"] + scan["spam_findings"],
        "spam_score": scan["spam_score"],
        "category": analysis["category"] if analysis else None,
        "priority": analysis["priority"] if analysis else None,
        "summary": analysis["summary"] if analysis else None,
        "llm_phishing": llm_phishing,
        "llm_reasons": llm_reasons + ([f"视觉复核：{visual_review.get('summary', '')}"] if visual_review else []),
        "status": actual_status,
        "recommended_status": recommended_status,
        "action_mode": get_action_policy()["mode"],
        "action_taken": 1 if action_taken else 0,
        "action_reason": action_reason,
        "url_chain": url_chain_results,
        "final_landing_domain": final_domain,
        "final_landing_ip": final_ip,
        "review_source": review_source,
        "raw_path": email["raw_path"],
        "processing_complete": 0,
    }
    email_id = db.upsert_email(record)

    # 11) 保存 URL 链详情到 url_chains 表
    for chain_result in url_chain_results:
        db.save_url_chain(
            email_id,
            chain_result["chain"][0]["url"] if chain_result.get("chain") else "",
            chain_result.get("chain", []),
            chain_result.get("final_url"),
            chain_result.get("final_domain"),
            chain_result.get("final_ip"),
            chain_result.get("status", ""),
        )

    # 12) 更新 thread 摘要
    try:
        # Historical thread context remains available through local summaries;
        # model-generated thread summaries are reserved for newly arriving mail.
        threads.update_thread(email_id, {**email, "id": email_id},
                              allow_ai=history_rank is None)
    except Exception:
        log.exception("更新 thread 失败 email_id=%s", email_id)

    # 13) 待办
    if analysis and analysis["todos"]:
        db.refresh_generated_todos(email_id, analysis["todos"])

    # 14) 服务器端移动（隔离/垃圾）；失败时回写为收件箱，避免状态与邮箱不一致
    old_status = "inbox"
    if action_taken:
        try:
            if actual_status == "quarantine":
                target_uid, target_folder = mail.move_to_quarantine(uid, config.INBOX_FOLDER)
                db.set_mail_state(email_id, folder=target_folder, uid=target_uid)
            elif actual_status == "spam":
                target_uid, target_folder = mail.move_to_spam(uid, config.INBOX_FOLDER)
                db.set_mail_state(email_id, folder=target_folder, uid=target_uid)
        except Exception as exc:
            actual_status = "inbox"
            action_taken = False
            action_reason = f"移动失败，已安全降级：{exc}"
            db.set_status(email_id, "inbox", config.INBOX_FOLDER)
            with db.conn() as c:
                c.execute("UPDATE emails SET action_taken=0, action_reason=? WHERE id=?",
                          (action_reason, email_id))
            log.exception("自动移动失败 uid=%s", uid)

    # 15) 审计日志
    if action_taken:
        db.add_audit_log(
            email_id, action=f"move_{actual_status}", old_status=old_status, new_status=actual_status,
            actor="system", reason=_rule_summary(scan),
            meta={"score": scan["score"], "verdict": verdict, "review_source": review_source,
                  "action_mode": get_action_policy()["mode"]},
        )
    elif recommended_status != "inbox":
        db.add_audit_log(
            email_id, action=f"recommend_{recommended_status}", old_status="inbox", new_status="inbox",
            actor="system", reason=action_reason,
            meta={"score": scan["score"], "verdict": verdict, "recommended_status": recommended_status},
        )

    db.finish_email_processing(email_id)
    if arrival_kind == 'new':
        try:
            from .mailbox_jobs import notify_new_message
            notify_new_message(email_id)
        except Exception:
            log.exception('新邮件通知失败 email_id=%s', email_id)

    log.info("处理 uid=%s [%s|%s|score=%s] %s",
             uid, actual_status, verdict, scan["score"], email["subject"][:50])
    return {"status": actual_status, "recommended_status": recommended_status,
            "action_taken": action_taken, "verdict": verdict,
            "score": scan["score"], "email_id": email_id}


@account_work
def poll_once() -> dict:
    """拉取并处理一批新邮件。已在运行时返回跳过。"""
    if not _poll_lock.acquire(blocking=False):
        return {"ok": False, "msg": "上一次拉取仍在进行"}
    try:
        _reset_cancel()
        _reset_action_guard()
        _set_fetch_state(True, operation="poll", message="正在拉取新邮件...")
        result = {"ok": True, "fetched": 0, "quarantined": 0, "errors": 0, "notifications_delivered": True}
        with MailClient() as mail:
            mail.ensure_quarantine_folder()
            mail.ensure_spam_folder()
            messages = mail.fetch_new(limit=config.INITIAL_FETCH_LIMIT)
            cursor_blocked = False
            _set_fetch_state(True, operation="poll", total=len(messages),
                             message=f"发现 {len(messages)} 封新邮件，正在处理...")
            for idx, (uid, raw) in enumerate(messages, 1):
                if _is_canceled():
                    _set_fetch_state(False, operation="poll", total=len(messages),
                                     processed=idx - 1, canceled=True,
                                     message=f"已取消，处理了 {idx - 1}/{len(messages)} 封")
                    return {**result, "canceled": True}
                if db.already_processed(config.INBOX_FOLDER, uid):
                    if not cursor_blocked:
                        db.set_last_uid(config.INBOX_FOLDER, uid)
                    continue
                try:
                    if raw is None:
                        raise RuntimeError(f'邮件 {uid} 正文暂未返回，将在下次同步重试')
                    _set_fetch_state(True, operation="poll", total=len(messages),
                                     processed=idx,
                                     message=f"正在处理第 {idx}/{len(messages)} 封...", persist=False)
                    r = process_message(mail, uid, raw)
                    result['fetched'] += 1
                    if r["status"] == "quarantine":
                        result["quarantined"] += 1
                except Exception:
                    log.exception("处理邮件失败 uid=%s", uid)
                    result["errors"] += 1
                    cursor_blocked = True
                finally:
                    if not cursor_blocked:
                        db.set_last_uid(config.INBOX_FOLDER, uid)
        final_error = f"{result['errors']} 封处理失败，下次同步将从失败位置重试" if result["errors"] else ""
        _set_fetch_state(False, operation="poll", total=len(messages),
                         processed=len(messages), error=final_error,
                         message=final_error or f"完成，共处理 {result['fetched']} 封")
        return result
    except Exception as e:
        _set_fetch_state(False, error=str(e), message="拉取失败")
        raise
    finally:
        _poll_lock.release()


class _InboxPriority:
    """Cooperatively check arrivals while a history task owns the mailbox lock.

    The history cursor is deliberately untouched: older failed UIDs must still
    be retried. Each checkpoint is bounded so history continues to make progress.
    """
    def __init__(self, ceiling=None):
        if ceiling is None:
            with db.conn() as c:
                ceiling = c.execute('SELECT COALESCE(MAX(uid),0) FROM emails WHERE folder=? AND is_local_archive=0',
                                    (config.INBOX_FOLDER,)).fetchone()[0]
        self.ceiling = int(ceiling)
        self.checked_at = time.monotonic()

    def check(self, mail):
        now = time.monotonic()
        if _is_canceled() or now - self.checked_at < 30:
            return
        self.checked_at = now
        try:
            mail.select_folder(config.INBOX_FOLDER, readonly=True)
            uids = sorted(int(uid) for uid in mail.client.search(['UID', f'{self.ceiling + 1}:*'])
                          if int(uid) > self.ceiling and not db.already_processed(config.INBOX_FOLDER, int(uid)))[:10]
            blocked = False
            for uid, raw in RawMessageBatch(mail.client, config.INBOX_FOLDER, uids, tolerate_missing=True):
                if _is_canceled():
                    return
                try:
                    if raw is None:
                        raise RuntimeError(f'邮件 {uid} 正文暂未返回')
                    process_message(mail, uid, raw, arrival_kind='new')
                    if not blocked:
                        self.ceiling = uid
                except Exception:
                    blocked = True
                    log.exception('优先收信暂未完成 uid=%s，将重试并继续处理其他邮件', uid)
        except Exception:
            log.exception('历史同步期间检查新邮件失败，将继续重试')


@account_work
def fetch_all(batch: int = 50, continue_with_folders: bool = False) -> dict:
    """拉取收件箱全部未处理邮件（历史补全）。后台分批执行。"""
    if not _poll_lock.acquire(blocking=False):
        return {"ok": False, "msg": "上一次拉取仍在进行"}
    try:
        _reset_cancel()
        _reset_action_guard()
        _set_fetch_state(True, operation="fetch_all", message="正在扫描未处理邮件...")
        result = {"ok": True, "fetched": 0, "quarantined": 0, "errors": 0}
        with MailClient() as mail:
            mail.ensure_quarantine_folder()
            mail.ensure_spam_folder()
            mail.select_folder(config.INBOX_FOLDER, readonly=True, reset_generation=True)
            server_uids = list(mail.client.search(["ALL"]))
            priority = _InboxPriority(max(server_uids, default=0))
            all_uids = [u for u in server_uids if not db.already_processed(config.INBOX_FOLDER, u)]
            if not all_uids:
                db.reconcile_folder(config.INBOX_FOLDER, server_uids)
                _set_fetch_state(bool(continue_with_folders), operation="sync_folders" if continue_with_folders else "fetch_all",
                                 message="收件箱已完成，正在准备其他文件夹…" if continue_with_folders else "没有更多未处理邮件")
                return {**result, "msg": "没有更多未处理邮件"}
            all_uids = _ordered_history_uids(all_uids)
            total = len(all_uids)
            log.info("fetch_all 发现 %s 封未处理邮件", total)
            _set_fetch_state(True, operation="fetch_all", total=total,
                             message=f"发现 {total} 封未处理邮件，正在分批处理...")
            processed = 0
            history_offset = db.count_history_imported()
            for i in range(0, total, batch):
                if _is_canceled():
                    _set_fetch_state(False, operation="fetch_all", total=total,
                                     processed=processed, canceled=True,
                                     message=f"已取消，处理了 {processed}/{total} 封")
                    return {**result, "canceled": True}
                batch_uids = all_uids[i:i + max(1, min(batch, 50))]
                mail.select_folder(config.INBOX_FOLDER, readonly=True)
                sizes = mail.client.fetch(batch_uids, ["RFC822.SIZE"])
                for uid in _ordered_history_uids(batch_uids):
                    priority.check(mail)
                    if _is_canceled():
                        _set_fetch_state(False, operation="fetch_all", total=total,
                                         processed=processed, canceled=True,
                                         message=f"已取消，处理了 {processed}/{total} 封")
                        return {**result, "canceled": True}
                    size_item = sizes.get(uid, {})
                    raw_size = int(size_item.get(b"RFC822.SIZE") or size_item.get("RFC822.SIZE") or 0)
                    if raw_size > 50 * 1024 * 1024:
                        result["errors"] += 1
                        log.warning("历史邮件超过 50MB，未下载 uid=%s size=%s", uid, raw_size)
                        continue
                    mail.select_folder(config.INBOX_FOLDER, readonly=True)
                    data = mail.client.fetch([uid], ["BODY.PEEK[]"])
                    if uid not in data or b"BODY[]" not in data[uid]:
                        continue
                    processed += 1
                    try:
                        _set_fetch_state(True, operation="fetch_all", total=total,
                                         processed=processed,
                                         message=f"正在解析并进行安全与 AI 分析：{processed}/{total}",
                                         persist=processed % 25 == 0)
                        raw = data[uid][b"BODY[]"]
                        r = process_message(mail, uid, raw,
                                            history_offset + processed)
                        result["fetched"] += 1
                        if r["status"] == "quarantine":
                            result["quarantined"] += 1
                    except Exception:
                        log.exception("处理邮件失败 uid=%s", uid)
                        result["errors"] += 1
            priority.check(mail)
            if not result["errors"]:
                # Priority checks may have imported mail after the first scan.
                mail.select_folder(config.INBOX_FOLDER, readonly=True)
                db.reconcile_folder(config.INBOX_FOLDER, list(mail.client.search(['ALL'])))
        final_error = f"仍有 {result['errors']} 封处理失败，可点击继续同步重试" if result["errors"] else ""
        _set_fetch_state(bool(continue_with_folders),
                         operation="sync_folders" if continue_with_folders else "fetch_all", total=total,
                         processed=processed, error=final_error,
                         message=(f"收件箱已处理 {processed}/{total} 封，正在准备其他文件夹…"
                                  if continue_with_folders else final_error or f"完成，共处理 {result['fetched']} 封"))
        log.info("fetch_all 完成: %s", result)
        return result
    except Exception as e:
        _set_fetch_state(False, error=str(e), message="拉取失败")
        raise
    finally:
        _poll_lock.release()


def _store_folder_message(folder: str, role: str, uid: int, raw: bytes, flags: list[str]) -> int:
    existing = db.get_email_by_folder_uid(folder, uid)
    if existing:
        # 即使邮件已同步，也刷新附件元数据，让新版 MIME 规则能修正历史签名图片。
        attachments = parser.attachment_metadata(raw)
        if attachments != (existing.get("attachments") or []):
            db.update_attachment_metadata(existing["id"], attachments)
        db.sync_mail_flags(existing["id"], is_read="\\Seen" in flags,
                           is_starred="\\Flagged" in flags)
        with db.conn() as connection:
            connection.execute(
                "UPDATE emails SET remote_missing=0 WHERE id=? AND COALESCE(pending_action,'')=''",
                (existing["id"],),
            )
        if existing.get("status") != role:
            db.set_status(existing["id"], role, folder)
        return existing["id"]
    parsed = parser.parse_message(uid, raw, folder=folder)
    record = {
        "uid": uid, "folder": folder, "message_id": parsed.get("message_id"),
        "in_reply_to": parsed.get("in_reply_to"), "references_header": parsed.get("references_header"),
        "thread_id": parsed.get("thread_id"), "subject": parsed.get("subject"),
        "from_addr": parsed.get("from_addr"), "from_name": parsed.get("from_name"),
        "to_addr": parsed.get("to_addr"), "recipient_names": parsed.get("recipient_names") or {},
        "cc_addr": parsed.get("cc_addr", ""),
        "date": parsed.get("date"),
        "snippet": parsed.get("snippet"), "body_text": parsed.get("body_text"),
        "body_html": parsed.get("body_html"), "urls": parsed.get("urls"),
        "attachments": parsed.get("attachments"), "summary": parsed.get("snippet"),
        "score": 0, "verdict": "clean", "findings": [], "status": role,
        "recommended_status": role, "review_source": "folder_sync",
        "action_mode": "observe", "action_taken": 0,
        "action_reason": "服务端文件夹只读同步，不执行安全移动", "raw_path": parsed.get("raw_path"),
    }
    email_id = db.upsert_email(record)
    db.sync_mail_flags(email_id, is_read="\\Seen" in flags, is_starred="\\Flagged" in flags)
    return email_id


def repair_inline_attachment_metadata() -> dict:
    """一次性修复历史邮件中被误当作附件的正文/签名图片。"""
    action = "repair_inline_attachment_metadata_v1"
    if db.audit_action_exists(action):
        return {"ok": True, "checked": 0, "updated": 0, "skipped": True}
    checked = updated = 0
    for row in db.list_inline_attachment_candidates():
        metadata = parser.attachment_metadata_from_path(row.get("raw_path"))
        if metadata is None:
            continue
        checked += 1
        if metadata != (row.get("attachments") or []):
            db.update_attachment_metadata(row["id"], metadata)
            updated += 1
    db.add_audit_log(None, action, actor="system", reason="修正正文内嵌图片的附件分类",
                     meta={"checked": checked, "updated": updated})
    return {"ok": True, "checked": checked, "updated": updated, "skipped": False}


def repair_mojibake_bodies() -> dict:
    """修复历史乱码正文，并移除明确由乱码诱发的模型证据后重算风险。"""
    action = "repair_mojibake_bodies_v1"
    if db.audit_action_exists(action):
        return {"ok": True, "checked": 0, "updated": 0, "skipped": True}
    checked = updated = 0
    encoding_terms = re.compile(r"乱码|编码(?:错误|异常|攻击)|乱码注入|恶意混淆")
    limits = policy.thresholds()
    for row in db.iter_emails():
        old_body = row.get("body_text") or ""
        raw_path = row.get("raw_path") or ""
        if not parser.looks_corrupted(old_body) or not os.path.isfile(raw_path):
            continue
        checked += 1
        try:
            with open(raw_path, "rb") as source:
                parsed = parser.parse_message(
                    int(row.get("uid") or 0), source.read(), save_raw=False,
                    folder=row.get("folder") or config.INBOX_FOLDER,
                )
        except Exception:
            log.exception("历史乱码正文重解析失败 email_id=%s", row.get("id"))
            continue
        if parsed.get("body_decode_warning") or parser.looks_corrupted(parsed.get("body_text", "")):
            continue

        findings = []
        for finding in row.get("findings") or []:
            detail = str(finding.get("detail") or "")
            if finding.get("code") == "VISION_SOCIAL_ENGINEERING" and encoding_terms.search(detail):
                continue
            findings.append(finding)
        score = min(100, sum(max(0, int(item.get("weight") or 0)) for item in findings))
        verdict = "phishing" if score >= limits["quarantine_score"] else (
            "suspicious" if score >= limits["review_score"] else "clean"
        )
        summary = row.get("summary") or ""
        if not summary or parser.looks_corrupted(summary):
            summary = parsed.get("snippet") or "正文已完成编码修复"
        recommended = "quarantine" if verdict == "phishing" else "inbox"
        with db.conn() as connection:
            connection.execute(
                "UPDATE emails SET snippet=?,body_text=?,body_html=?,urls=?,summary=?,score=?,verdict=?,"
                "findings=?,llm_phishing=NULL,llm_reasons='[]',review_source='encoding_repair',"
                "recommended_status=?,action_reason=? WHERE id=?",
                (parsed.get("snippet"), parsed.get("body_text"), parsed.get("body_html"),
                 json.dumps(parsed.get("urls") or [], ensure_ascii=False), summary, score, verdict,
                 json.dumps(findings, ensure_ascii=False), recommended,
                 "正文编码已修复并重新计算风险；未自动移动服务器邮件", row["id"]),
            )
        updated += 1
    db.add_audit_log(None, action, actor="system", reason="修复历史正文乱码并撤销乱码诱发的模型证据",
                     meta={"checked": checked, "updated": updated})
    return {"ok": True, "checked": checked, "updated": updated, "skipped": False}


def repair_retired_security_signals() -> dict:
    """Remove retired AUTH_NONE and reapply built-in business-domain trust.

    Existing rows keep their server folder. Only local evidence, score, verdict and
    recommendation are corrected, so startup repair cannot move user mail.
    """
    action = "retire_auth_none_and_trust_business_domains_v1"
    if db.audit_action_exists(action):
        return {"ok": True, "checked": 0, "updated": 0, "skipped": True}
    checked = updated = 0
    limits = policy.thresholds()
    non_blocking_url_codes = {
        "URL_IP", "URL_AT", "URL_PUNYCODE", "URL_SHORT", "URL_TLD", "URL_ANCHOR",
        "URL_LOOKALIKE", "URL_CHAIN_ERROR", "URL_REDIRECT_CHAIN", "URL_FINAL_LOOKALIKE",
        "URL_SHORT_EXPANDED", "URL_ANOMALY",
    }
    for row in db.iter_emails():
        original = row.get("findings") or []
        trusted_sender = policy.allowlist_match(row.get("from_addr", ""))
        trusted_landing = policy.is_trusted_domain(row.get("final_landing_domain", ""))
        findings = [item for item in original if item.get("code") != "AUTH_NONE"]
        if trusted_sender:
            findings = policy.apply_allowlist(findings, trusted_sender)
            if trusted_sender.get("id") == 0:
                findings = [item for item in findings if item.get("code") not in {
                    "DOMAIN_LOOKALIKE", "SENDER_LOOKALIKE", "DISPLAY_SPOOF", "DNS_MX", "DNS_SPF",
                }]
        if trusted_landing:
            findings = [item for item in findings if item.get("code") not in non_blocking_url_codes]
        if findings == original:
            continue
        checked += 1
        score = min(100, sum(max(0, int(item.get("weight") or 0)) for item in findings))
        verdict = row.get("verdict") or "clean"
        if row.get("review_source") != "llm" and row.get("feedback") not in ("fp", "fn"):
            verdict = "phishing" if score >= limits["quarantine_score"] else (
                "suspicious" if score >= limits["review_score"] else "clean"
            )
        recommended = row.get("recommended_status") or "inbox"
        if recommended == "quarantine" and verdict != "phishing":
            recommended = "inbox"
        with db.conn() as connection:
            connection.execute(
                "UPDATE emails SET findings=?,score=?,verdict=?,recommended_status=?,action_reason=? WHERE id=?",
                (json.dumps(findings, ensure_ascii=False), score, verdict, recommended,
                 "已移除无效认证缺失信号并应用可信业务域名；未移动服务器邮件", row["id"]),
            )
        updated += 1
    db.add_audit_log(None, action, actor="system", reason="移除 AUTH_NONE 并应用内置业务域名白名单",
                     meta={"checked": checked, "updated": updated})
    return {"ok": True, "checked": checked, "updated": updated, "skipped": False}


def repair_local_mail_data() -> dict:
    return {
        "attachments": repair_inline_attachment_metadata(),
        "encoding": repair_mojibake_bodies(),
        "security_rules": repair_retired_security_signals(),
    }


def _sync_one_folder(mail: MailClient, mailbox: dict, limit: int = 0,
                     progress_callback=None) -> int:
    folder = mailbox["name"]
    role = mailbox_role(mailbox)
    imported, seen_uids = 0, []
    known_uids = db.folder_uids(folder)
    priority = getattr(mail, '_mailai_inbox_priority', None)
    if not isinstance(priority, _InboxPriority):
        priority = mail._mailai_inbox_priority = _InboxPriority()
    for uid, raw, flags in mail.fetch_folder(folder, limit, known_uids):
        if folder != config.INBOX_FOLDER:
            priority.check(mail)
        if _is_canceled():
            break
        if raw is None:
            existing = db.get_email_by_folder_uid(folder, uid)
            if existing:
                db.sync_mail_flags(existing["id"], is_read="\\Seen" in flags,
                                   is_starred="\\Flagged" in flags)
                with db.conn() as connection:
                    connection.execute(
                        "UPDATE emails SET remote_missing=0 WHERE id=? AND COALESCE(pending_action,'')=''",
                        (existing["id"],),
                    )
        else:
            _store_folder_message(folder, role, uid, raw, flags)
        seen_uids.append(uid)
        imported += 1
        if progress_callback:
            progress_callback(imported)
    missing = db.reconcile_folder(folder, seen_uids) if limit == 0 and not _is_canceled() else 0
    db.add_audit_log(None, "folder_sync", actor="system", reason=f"同步文件夹 {folder}",
                     meta={"imported": imported, "remote_missing": missing, "role": role})
    return imported


@account_work
def sync_mail_folder(folder: str, limit: int = 0) -> dict:
    """Synchronize one server folder without running phishing analysis or moving mail."""
    if not _poll_lock.acquire(blocking=False):
        return {"ok": False, "msg": "上一次同步仍在进行"}
    detail = []
    try:
        _reset_cancel()
        with MailClient() as mail:
            mailbox = next((item for item in mail.list_mailboxes() if item["name"] == folder), None)
            if not mailbox or not mailbox.get("selectable", True):
                raise ValueError("服务端文件夹不存在或不可读取")
            folder_total = min(int(mailbox.get("messages") or 0), limit) if limit else int(mailbox.get("messages") or 0)
            detail = [{"name": folder[:160], "role": mailbox_role(mailbox), "total": folder_total,
                       "processed": 0, "status": "running", "error": ""}]
            _set_fetch_state(True, operation="sync_folder", total=folder_total,
                             message=f"正在同步 {folder}...", folder_progress=detail,
                             current_folder=folder[:160])
            last_update = [0.0]
            def report(count):
                now = time.monotonic()
                if count < folder_total and now - last_update[0] < .25:
                    return
                last_update[0] = now
                detail[0]["processed"] = count
                _set_fetch_state(True, operation="sync_folder", total=folder_total,
                                 processed=count, message=f"正在同步 {folder}：{count}/{folder_total}",
                                 folder_progress=detail, current_folder=folder[:160], persist=False)
            imported = _sync_one_folder(mail, mailbox, limit, report)
            detail[0].update(processed=imported, status="completed" if not _is_canceled() else "canceled")
        _set_fetch_state(False, operation="sync_folder", total=imported, processed=imported,
                         canceled=_is_canceled(), folder_progress=detail,
                         message=f"{folder} 同步完成，共 {imported} 封" if not _is_canceled() else f"{folder} 同步已取消")
        return {"ok": True, "folder": folder, "role": mailbox_role(mailbox), "imported": imported}
    except Exception as exc:
        if detail:
            detail[0].update(status="failed", error=str(exc)[:160])
        _set_fetch_state(False, operation="sync_folder", error=str(exc), message=f"{folder} 同步失败",
                         folder_progress=detail)
        raise
    finally:
        _poll_lock.release()


@account_work
def sync_auxiliary_folders(limit_per_folder: int = 0, preserve_cancel: bool = False) -> dict:
    """Complete first-run IMAP initialization for Sent, Drafts and custom folders."""
    if not _poll_lock.acquire(blocking=False):
        return {"ok": False, "msg": "上一次同步仍在进行"}
    progress, omitted, total, processed = [], 0, 0, 0
    try:
        if not preserve_cancel:
            _reset_cancel()
        elif _is_canceled():
            _set_fetch_state(False, operation="sync_folders", canceled=True,
                             message="完整初始化已取消")
            return {"ok": True, "folders": 0, "imported": 0, "errors": [], "canceled": True}
        result = {"ok": True, "folders": 0, "imported": 0, "errors": []}
        with MailClient() as mail:
            # Special-use quarantine/junk folders are first-class mailboxes and
            # must be imported too; otherwise their server counts have no rows.
            excluded = {config.INBOX_FOLDER}
            mailboxes = [item for item in mail.list_mailboxes()
                         if item.get("selectable", True) and item["name"] not in excluded
                         and mailbox_role(item) != "all"]
            progress = [{"name": str(item["name"])[:160], "role": mailbox_role(item),
                         "total": min(int(item.get("messages") or 0), limit_per_folder) if limit_per_folder else int(item.get("messages") or 0),
                         "processed": 0, "status": "pending", "error": ""}
                        for item in mailboxes[:_MAX_FOLDER_PROGRESS]]
            omitted = max(0, len(mailboxes) - len(progress))
            total = sum(min(int(item.get("messages") or 0), limit_per_folder)
                        if limit_per_folder else int(item.get("messages") or 0) for item in mailboxes)
            processed = 0
            _set_fetch_state(True, operation="sync_folders", total=total,
                             message=f"正在同步 {len(mailboxes)} 个其他文件夹...",
                             folder_progress=progress, folder_omitted=omitted)
            for index, mailbox in enumerate(mailboxes):
                if _is_canceled():
                    result["canceled"] = True
                    break
                detail = progress[index] if index < len(progress) else None
                folder_total = min(int(mailbox.get("messages") or 0), limit_per_folder) if limit_per_folder else int(mailbox.get("messages") or 0)
                if detail:
                    detail["status"] = "running"
                _set_fetch_state(True, operation="sync_folders", total=total, processed=processed,
                                 message=f"正在同步 {mailbox['name']}…", folder_progress=progress,
                                 current_folder=str(mailbox["name"])[:160], folder_omitted=omitted)
                base_processed = processed
                last_update = [0.0]
                last_count = [0]
                def report(count):
                    last_count[0] = count
                    now = time.monotonic()
                    if count < folder_total and now - last_update[0] < .25:
                        return
                    last_update[0] = now
                    if detail:
                        detail["processed"] = count
                    _set_fetch_state(True, operation="sync_folders", total=total,
                                     processed=min(total, base_processed + count),
                                     message=f"正在同步 {mailbox['name']}：{count}/{folder_total}",
                                     folder_progress=progress, current_folder=str(mailbox["name"])[:160],
                                     folder_omitted=omitted, persist=False)
                try:
                    count = _sync_one_folder(mail, mailbox, limit_per_folder, report)
                    result["folders"] += 1
                    result["imported"] += count
                    processed += count
                    if _is_canceled():
                        result["canceled"] = True
                    if detail:
                        detail.update(processed=count, status="canceled" if _is_canceled() else "completed")
                    if _is_canceled():
                        break
                    _set_fetch_state(True, operation="sync_folders", total=total, processed=processed,
                                     message=f"已同步 {mailbox['name']}，继续处理其他文件夹...",
                                     folder_progress=progress, folder_omitted=omitted)
                except Exception as exc:
                    log.exception("同步服务端文件夹失败 folder=%s", mailbox["name"])
                    result["errors"].append({"folder": mailbox["name"], "error": str(exc)[:160]})
                    processed += last_count[0]
                    if detail:
                        detail.update(status="failed", error=str(exc)[:160])
            if result.get("canceled"):
                for item in progress:
                    if item["status"] in ("pending", "running"):
                        item["status"] = "canceled"
        error = f"{len(result['errors'])} 个文件夹同步失败，可稍后单独重试" if result["errors"] else ""
        _set_fetch_state(False, operation="sync_folders", total=total, processed=processed,
                         canceled=result.get("canceled", False), error=error,
                         message=error or f"完整初始化完成，共同步 {result['imported']} 封其他文件夹邮件",
                         folder_progress=progress, folder_omitted=omitted)
        result["ok"] = not result["errors"]
        return result
    except Exception as exc:
        _set_fetch_state(False, operation="sync_folders", error=str(exc), message="其他文件夹同步失败",
                         folder_progress=progress, folder_omitted=omitted)
        raise
    finally:
        _poll_lock.release()


@account_work
def fetch_more(limit: int = 20) -> dict:
    """翻页拉取更早的历史邮件。"""
    if not _poll_lock.acquire(blocking=False):
        return {"ok": False, "msg": "上一次拉取仍在进行"}
    try:
        _reset_cancel()
        _reset_action_guard()
        _set_fetch_state(True, operation="fetch_more", message="正在加载更早邮件...")
        result = {"ok": True, "fetched": 0, "quarantined": 0, "errors": 0, "has_more": False}
        with MailClient() as mail:
            mail.ensure_quarantine_folder()
            mail.ensure_spam_folder()
            before_uid = db.get_first_uid(config.INBOX_FOLDER)
            if before_uid <= 1:
                _set_fetch_state(False, message="没有更早的邮件了")
                return {**result, "msg": "没有更早的邮件了"}
            messages = mail.fetch_older(before_uid, limit)
            result["fetched"] = len(messages)
            result["has_more"] = len(messages) >= limit
            total = len(messages)
            _set_fetch_state(True, operation="fetch_more", total=total,
                             message=f"发现 {total} 封更早邮件，正在处理...")
            ordered = messages.newest_first() if hasattr(messages, 'newest_first') else sorted(messages, key=lambda x: x[0], reverse=True)
            idx = 0
            history_offset = db.count_history_imported()
            for idx, (uid, raw) in enumerate(ordered, 1):
                if _is_canceled():
                    _set_fetch_state(False, operation="fetch_more", total=total,
                                     processed=idx - 1, canceled=True,
                                     message=f"已取消，处理了 {idx - 1}/{total} 封")
                    return {**result, "canceled": True}
                if db.already_processed(config.INBOX_FOLDER, uid):
                    continue
                try:
                    _set_fetch_state(True, operation="fetch_more", total=total,
                                     processed=idx,
                                     message=f"正在处理第 {idx}/{total} 封...")
                    r = process_message(mail, uid, raw, history_offset + idx)
                    if r["status"] == "quarantine":
                        result["quarantined"] += 1
                except Exception:
                    log.exception("处理历史邮件失败 uid=%s", uid)
                    result["errors"] += 1
                    # Do not lower MIN(uid) past a failed older message.
                    break
        final_error = "历史邮件处理失败，已暂停；下次加载更多将重试" if result["errors"] else ""
        _set_fetch_state(False, operation="fetch_more", total=total,
                         processed=idx if messages else 0, error=final_error,
                         message=final_error or f"完成，共处理 {result['fetched']} 封")
        return result
    except Exception as e:
        _set_fetch_state(False, error=str(e), message="拉取失败")
        raise
    finally:
        _poll_lock.release()


def restore_email(email_id: int, *, actor: str = "user", reason: str = "误报恢复",
                  audit_action: str = "restore") -> bool:
    """误报恢复：从隔离区/垃圾邮件移回收件箱。
    注意：邮件移动后 UID 会变（UID 是按文件夹分配的），
    所以用 Message-ID 在源文件夹里重新定位。"""
    row = db.get_email(email_id)
    if row and (row.get('is_local_archive') or row.get('cleanup_hold')):
        raise ValueError('仅本地保留或正在清理的邮件不能执行服务器操作')
    if not row or row["status"] == "inbox":
        return False
    # The provider may call its special-use folder "Junk E-mail", "Spam", etc.
    # Always restore from the exact folder recorded after the successful move.
    src_folder = row["folder"]
    with MailClient() as mail:
        mail.client.select_folder(src_folder)
        uids = []
        if row.get("message_id"):
            uids = mail.client.search(["HEADER", "Message-ID", row["message_id"]])
        if len(uids) != 1:
            raise RuntimeError("无法唯一定位原邮件，恢复已停止；请同步源文件夹后重试")
        target_uid = mail.move(uids[0], src_folder, config.INBOX_FOLDER)
    old_status = row["status"]
    db.set_mail_state(email_id, folder=config.INBOX_FOLDER, uid=target_uid)
    db.set_status(email_id, "inbox", config.INBOX_FOLDER)
    db.set_reviewed(email_id)
    with db.conn() as c:
        c.execute("UPDATE emails SET action_taken=0, action_reason=? WHERE id=?",
                  (reason, email_id))
    db.add_audit_log(
        email_id, action=audit_action, old_status=old_status, new_status="inbox",
        actor=actor, reason=reason,
    )
    return True


def rollback_recent_auto_actions(limit: int = 10) -> dict:
    """回滚最近一批仍有效的自动移动；单封失败不影响其他邮件。"""
    candidates = db.list_auto_action_candidates(limit)
    result = {"requested": len(candidates), "restored": 0, "failed": 0, "items": []}
    for row in candidates:
        try:
            ok = restore_email(
                row["id"], actor="system", audit_action="batch_rollback",
                reason="用户触发最近自动处置批量回滚",
            )
            result["restored"] += 1 if ok else 0
            result["failed"] += 0 if ok else 1
            result["items"].append({"email_id": row["id"], "ok": ok})
        except Exception as exc:
            log.exception("批量回滚失败 email_id=%s", row["id"])
            result["failed"] += 1
            result["items"].append({"email_id": row["id"], "ok": False, "error": str(exc)})
    db.add_audit_log(
        None, action="batch_rollback_summary", actor="user",
        reason=f"批量回滚完成：成功 {result['restored']}，失败 {result['failed']}",
        meta={"limit": limit, **result},
    )
    return result


class RemoteMessageUnavailable(RuntimeError):
    """The local evidence exists, but the corresponding server message is gone."""


def confirm_email(email_id: int) -> dict | bool:
    """确认检测结果；人工确认模式下执行尚未落地的处置建议。"""
    row = db.get_email(email_id)
    if row and (row.get('is_local_archive') or row.get('cleanup_hold')):
        raise ValueError('仅本地保留或正在清理的邮件不能执行服务器操作')
    if not row:
        return False
    recommended = row.get("recommended_status") or row["status"]
    if row["status"] == "inbox" and recommended in ("quarantine", "spam"):
        with MailClient() as mail:
            move = mail.move_to_spam if recommended == "spam" else mail.move_to_quarantine
            try:
                target_uid, target_folder = move(row["uid"], row["folder"])
                recovered = ""
            except Exception as exc:
                if "源邮件已不存在" not in str(exc):
                    raise
                # UIDs may change after a server folder rebuild. Message-ID is stable,
                # so first retry the exact source folder with its current UID.
                source_uid = mail.find_message_uid(row["folder"], row.get("message_id") or "")
                if source_uid:
                    target_uid, target_folder = move(source_uid, row["folder"])
                    recovered = "stale_uid"
                else:
                    target_folder = (mail.ensure_spam_folder() if recommended == "spam"
                                     else mail.ensure_quarantine_folder())
                    target_uid = mail.find_message_uid(target_folder, row.get("message_id") or "")
                    if target_uid:
                        # A previous attempt or another client already completed the move.
                        recovered = "already_moved"
                    else:
                        db.set_remote_missing(email_id)
                        db.add_audit_log(
                            email_id, action="confirm_remote_missing", old_status=row["status"],
                            new_status=row["status"], actor="user",
                            reason="确认处置时服务端源邮件已不存在",
                            meta={"recommended_status": recommended, "folder": row["folder"], "uid": row["uid"]},
                        )
                        raise RemoteMessageUnavailable(
                            "服务器中已找不到这封邮件，可能已被其他客户端移动或删除；本地列表已刷新"
                        ) from exc
        db.set_mail_state(email_id, folder=target_folder, uid=target_uid)
        db.set_status(email_id, recommended, target_folder)
        with db.conn() as c:
            c.execute("UPDATE emails SET action_taken=1, action_reason=? WHERE id=?",
                      ("用户人工确认后执行处置", email_id))
        db.set_reviewed(email_id)
        db.add_audit_log(
            email_id, action=f"approve_{recommended}", old_status="inbox", new_status=recommended,
            actor="user", reason="用户人工确认处置建议",
            meta={"recommended_status": recommended},
        )
        return {"ok": True, "moved": True, "status": recommended, "folder": target_folder,
                "recovered": recovered}
    db.set_reviewed(email_id)
    db.add_audit_log(
        email_id, action="confirm", old_status=row["status"], new_status=row["status"],
        actor="user", reason="确认处置",
    )
    return {"ok": True, "moved": False, "status": row["status"], "folder": row["folder"]}


def record_feedback(email_id: int, feedback: str, note: str = "", trust_sender: bool = False) -> dict | bool:
    """用户反馈误报(fp)或漏报(fn)。"""
    if feedback not in ("fp", "fn"):
        return False
    if trust_sender and feedback != "fp":
        raise ValueError("只有标记为正常时才能信任发件人")
    note = str(note or "").strip()[:500]
    row = db.get_email(email_id)
    if row and (row.get('is_local_archive') or row.get('cleanup_hold')):
        raise ValueError('仅本地保留或正在清理的邮件不能执行服务器操作')
    if not row:
        return False
    trusted_address = policy.normalize_address(row.get("from_addr", "")) if trust_sender else ""
    if trust_sender and not trusted_address:
        raise ValueError("无法识别有效的发件邮箱地址，未添加白名单")
    existing_address = next(
        (item for item in db.list_security_allowlist()
         if item.get("kind") == "address" and policy.normalize_address(item.get("value", "")) == trusted_address),
        None,
    ) if trusted_address else None
    old_status = row["status"]
    if feedback == "fn":
        new_status = "quarantine"
        target_folder = config.QUARANTINE_FOLDER
        verdict = "phishing"
    elif feedback == "fp":
        # 正常的归档邮件留在原文件夹，只恢复隔离/垃圾文件夹中的误报。
        should_restore = (row["status"] in ("quarantine", "spam") or
                          row["folder"] in (config.QUARANTINE_FOLDER, config.SPAM_FOLDER))
        target_folder = config.INBOX_FOLDER if should_restore else row["folder"]
        new_status = "inbox" if target_folder == config.INBOX_FOLDER else old_status
        verdict = "clean"
    target_uid = row["uid"]
    if row["folder"] != target_folder:
        with MailClient() as mail:
            target_uid = mail.move(row["uid"], row["folder"], target_folder)
    # 服务端成功后一次性提交本地结果；失败时不伪造已恢复/已隔离状态。
    allowlist_entry = None
    with db.conn() as c:
        c.execute(
            "UPDATE emails SET folder=?,uid=?,status=?,verdict=?,reviewed=1,"
            "feedback=?,feedback_note=?,recommended_status=?,action_taken=?,"
            "action_reason=?,score=?,review_source='feedback_adjust',"
            "llm_phishing=? WHERE id=?",
            (target_folder, target_uid, new_status, verdict, feedback, note,
             new_status, int(feedback == "fn"), note or "用户反馈",
             int(row.get("score") or 0) if feedback == "fp" else max(int(row.get("score") or 0), 50),
             0 if feedback == "fp" else 1, email_id),
        )
        if trusted_address:
            allowlist_note = ((existing_address or {}).get("note") or "由误报反馈添加：发件人可信")
            allowlist_entry = db.upsert_security_allowlist_address(
                trusted_address, enabled=True, note=allowlist_note, connection=c,
            )
    db.add_audit_log(
        email_id, action=f"feedback_{feedback}", old_status=old_status, new_status=new_status,
        actor="user", reason=note or "用户反馈",
        meta={"feedback": feedback, "scope": "current_email_only",
              "trusted_sender": trusted_address or None},
    )
    if allowlist_entry:
        db.add_audit_log(
            email_id, action="allowlist_change", actor="user",
            reason=f"由误报反馈启用可信邮箱 {trusted_address}",
            meta={"kind": "address", "value": trusted_address, "enabled": True,
                  "source": "false_positive_feedback"},
        )
    return {"ok": True, "calibrated": 0, "trusted_sender": trusted_address or None,
            "allowlist_entry": allowlist_entry}


def _digest_items() -> list[dict]:
    """汇总今天邮件与所有未完成待办，供日报生成（一次性/流式共用）。"""
    from datetime import date, datetime
    today = date.today()

    def _todo_status(deadline_str):
        if not deadline_str:
            return "未指定"
        try:
            s = deadline_str.replace(" ", "T").split("+")[0].split("Z")[0]
            dl = datetime.fromisoformat(s).date()
            if dl < today:
                return "⚠️过期"
            if dl == today:
                return "今日"
            return "近期"
        except Exception:
            return "未指定"

    # 1) 今天邮件（需要关注的主要来源）
    today_emails = db.list_emails(days=1, limit=100)
    today_ids = {e["id"] for e in today_emails}

    # 2) 所有未完成待办，可能来自更早邮件
    open_todos = db.list_todos(include_done=False)
    todo_email_ids = {t.get("email_id") for t in open_todos if t.get("email_id")}

    # 3) 把有待办的旧邮件也拉进来，避免过期待办被漏掉
    old_ids = todo_email_ids - today_ids
    old_emails = []
    if old_ids:
        old_emails = [e for email_id in old_ids if (e := db.get_email(email_id)) and not e.get('remote_missing')]

    emails_map = {e["id"]: e for e in old_emails}
    for e in today_emails:
        emails_map[e["id"]] = e

    todos_by_email = {}
    for t in open_todos:
        todos_by_email.setdefault(t.get("email_id"), []).append({
            "title": t["title"],
            "email_id": t.get("email_id"),
            "deadline": t.get("deadline"),
            "status": _todo_status(t.get("deadline")),
        })

    items = []
    for e in emails_map.values():
        items.append({
            "email_id": e["id"],
            "from_addr": e["from_addr"], "subject": e["subject"],
            "category": e.get("category"), "priority": e.get("priority"),
            "score": e.get("score"),
            "summary": e.get("summary") or e.get("snippet", "")[:80],
            "date": e.get("date"),
            "todos": todos_by_email.get(e["id"], []),
        })
    return items


def today_digest() -> str:
    return llm_analyze.daily_digest(_digest_items())


def today_digest_stream():
    """流式生成今日日报，逐段产出文本 delta。"""
    yield from llm_analyze.daily_digest_stream(_digest_items())
