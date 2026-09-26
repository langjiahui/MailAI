"""邮件操作：已读/星标/收藏、移动、批量、删除与撤销、处置反馈、会话与审计。"""
import logging
import re

from fastapi import APIRouter, HTTPException

from ... import config, db, pipeline, threads
from ...imap_client import mailbox_role
from ...reply_recipients import recipients as reply_recipients
from ..helpers import correspondence_payload, current_server
from ..schemas import BulkMailRequest, TrashPurgeRequest

log = logging.getLogger(__name__)
router = APIRouter()


@router.post('/api/trash/purge/preview')
def api_trash_purge_preview(payload: TrashPurgeRequest):
    from ...trash_purge import preview
    try:
        return preview(current_server().MailClient, payload.ids, payload.empty)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except Exception as exc:
        raise HTTPException(502, f'无法核对垃圾箱：{exc}')


@router.post('/api/trash/purge/execute')
def api_trash_purge_execute(payload: TrashPurgeRequest):
    from ...trash_purge import execute, schedule
    try:
        result = execute(current_server().MailClient, payload.token, payload.confirmed)
        try:
            schedule()
        except Exception:
            log.exception('本地删除已完成，后台任务等待定时重试')
        return result
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except Exception as exc:
        raise HTTPException(500, f'本地删除未全部完成，请刷新核对：{exc}')


@router.get('/api/trash/purge/status')
def api_trash_purge_status():
    from ...trash_purge import status
    return status()


@router.post('/api/trash/purge/acknowledge')
def api_trash_purge_acknowledge(payload: TrashPurgeRequest):
    from ...trash_purge import acknowledge
    return acknowledge(payload.ids)


@router.post("/api/emails/{email_id}/read")
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


@router.post('/api/emails/{email_id}/favorite')
def api_set_email_favorite(email_id: int, value: bool = True):
    with db.conn() as c:
        result = c.execute('UPDATE emails SET is_favorite=? WHERE id=?', (int(value), email_id))
        if not result.rowcount:
            raise HTTPException(404, '邮件不存在')
    return {'ok': True, 'is_favorite': value}


@router.post("/api/emails/{email_id}/star")
def api_set_email_star(email_id: int, value: bool = True):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    if row.get('is_local_archive') or row.get('cleanup_hold'):
        raise HTTPException(409, '仅本地保留或正在清理的邮件不能执行服务器操作，可使用本地收藏')
    try:
        with current_server().MailClient() as mail:
            mail.set_flagged(row["uid"], row["folder"], value)
        db.set_mail_state(email_id, is_starred=value)
        db.add_audit_log(email_id, "star" if value else "unstar", actor="user")
        from ...mail_undo import record
        return {"ok": True, "is_starred": value, 'undo_token': record('star', [row], [db.get_email(email_id)])}
    except Exception as exc:
        log.exception("更新星标状态失败")
        raise HTTPException(502, f"更新星标状态失败: {exc}")


@router.post("/api/emails/{email_id}/move")
def api_move_email(email_id: int, target: str):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    if not target or target == row["folder"]:
        raise HTTPException(400, "目标文件夹无效")
    if row.get('is_local_archive') or row.get('cleanup_hold'):
        raise HTTPException(409, '仅本地保留或正在清理的邮件不能执行服务器操作，可使用本地收藏')
    try:
        with current_server().MailClient() as mail:
            folders = mail.list_mailboxes()
            names = {item["name"] for item in folders}
            if target not in names:
                raise HTTPException(400, "目标文件夹不存在")
            target_uid = mail.move(row["uid"], row["folder"], target)
        db.set_mail_state(email_id, folder=target, uid=target_uid)
        db.set_status(email_id, mailbox_role(next(item for item in folders if item['name'] == target)))
        db.add_audit_log(email_id, "move_folder", actor="user", reason=f"移动到 {target}")
        from ...mail_undo import record
        return {"ok": True, "folder": target, 'undo_token': record('move', [row], [db.get_email(email_id)])}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("移动邮件失败")
        raise HTTPException(502, f"移动邮件失败: {exc}")


@router.post("/api/emails/bulk")
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
    if payload.action != 'read' and any(row.get('cleanup_hold') or
            (row.get('is_local_archive') and payload.action not in ('trash', 'cancel_trash')) for row in rows):
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
        from ...mail_undo import record
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
        from ...mail_undo import record
        return {
            'ok': not failed, 'completed': len(before), 'queued': len(before),
            'reconciled': 0, 'failed': failed,
            'undo_token': record('read', before, after) if before else None,
        }
    completed, reconciled, failed = 0, 0, [{'id': i, 'error': '邮件不存在'} for i in ids if not any(row['id'] == i for row in rows)]
    before, after = [], []
    try:
        with current_server().MailClient() as mail:
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
    from ...mail_undo import record
    return {"ok": not failed, "completed": completed, "reconciled": reconciled, "failed": failed,
            # Trash is a server-resolved move; record it as such so undo moves
            # the message back instead of treating the action like a flag edit.
            'undo_token': record('move' if payload.action == 'trash' else payload.action,
                                 before, after) if before else None}


@router.post('/api/mail/undo/{token}')
def api_undo_mail(token: str):
    from ...mail_undo import restore
    try:
        return restore(token)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.post("/api/emails/{email_id}/restore")
def api_restore(email_id: int):
    try:
        ok = pipeline.restore_email(email_id)
    except Exception as e:
        log.exception("恢复失败")
        raise HTTPException(500, f"恢复失败: {e}")
    if not ok:
        raise HTTPException(400, "无法恢复（邮件不存在或已在收件箱）")
    return {"ok": True}


@router.post("/api/actions/rollback-recent")
def api_rollback_recent(limit: int = 10):
    """回滚最近一批仍在隔离区/垃圾箱中的自动处置邮件。"""
    if limit < 1 or limit > 50:
        raise HTTPException(400, "limit 必须在 1 到 50 之间")
    return pipeline.rollback_recent_auto_actions(limit)


@router.post("/api/emails/{email_id}/confirm")
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


@router.post("/api/emails/{email_id}/feedback")
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


@router.get("/api/emails/{email_id}/reply-recipients")
def api_reply_recipients(email_id: int, reply_all: bool = False):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    try:
        return reply_recipients(row, config.IMAP_USER, reply_all)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/api/emails/{email_id}/thread")
def api_email_thread(email_id: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    return threads.build_thread_context(row)


@router.get("/api/emails/{email_id}/correspondence")
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
    return correspondence_payload(counterpart, limit)


@router.get("/api/emails/{email_id}/audit")
def api_email_audit(email_id: int, limit: int = 50):
    if not db.get_email(email_id):
        raise HTTPException(404, "邮件不存在")
    return db.list_audit_logs(email_id=email_id, limit=limit)


# A far-future due date pauses a task without losing its durable remote phase.
_ACTION_PAUSED = '9999-12-31T23:59:59'


@router.get('/api/mail/action-sync')
def api_action_sync(include_paused: bool = False):
    # Retire legacy jobs immediately when opening the panel, even if this
    # account cannot authenticate and its background worker has not run.
    from ...trash_queue import mutation_lock
    lock = mutation_lock()
    if lock.acquire(blocking=False):
        try:
            db.discard_exhausted_trash_actions()
        finally:
            lock.release()
    with db.conn() as c:
        clause = "pending_action IN ('trash','trash_copying','trash_copied','trash_locating')"
        paused = c.execute(f"SELECT COUNT(*) FROM emails WHERE {clause} AND pending_due_at=?", (_ACTION_PAUSED,)).fetchone()[0]
        where = clause if include_paused else clause + " AND COALESCE(pending_due_at,'')<>?"
        params = () if include_paused else (_ACTION_PAUSED,)
        rows = [dict(row) for row in c.execute(
            "SELECT id,subject,pending_action,pending_error,pending_due_at,pending_attempts "
            f"FROM emails WHERE {where} ORDER BY id DESC LIMIT 100", params)]
        count = c.execute(f"SELECT COUNT(*) FROM emails WHERE {where}", params).fetchone()[0]
    for row in rows:
        row['paused'] = row['pending_due_at'] == _ACTION_PAUSED
    return {'rows': rows, 'total': count, 'paused_count': paused}


def _change_action_schedule(email_id: int, pause: bool):
    from ...trash_queue import mutation_lock
    lock = mutation_lock()
    if not lock.acquire(blocking=False):
        raise HTTPException(409, '服务器操作正在进行，请稍后再试')
    try:
        db.discard_exhausted_trash_actions()
        with db.conn() as c:
            changed = c.execute(
                "UPDATE emails SET pending_due_at=? WHERE id=? "
                "AND pending_action IN ('trash','trash_copying','trash_copied','trash_locating') "
                "AND (COALESCE(pending_error,'')<>'' OR pending_due_at=?)",
                (_ACTION_PAUSED if pause else '', email_id, _ACTION_PAUSED)).rowcount
        if not changed:
            raise HTTPException(409, '该任务已完成或仍在处理中，请刷新状态')
        db.add_audit_log(email_id, 'pause_trash_sync' if pause else 'resume_trash_sync', actor='user',
                         reason='保留本地删除状态及服务器操作阶段')
    finally:
        lock.release()
    return {'ok': True, 'scheduled': not pause, 'paused': pause}


@router.post('/api/mail/action-sync/{email_id}/retry')
def api_retry_action_sync(email_id: int):
    return _change_action_schedule(email_id, False)


@router.post('/api/mail/action-sync/{email_id}/pause')
def api_pause_action_sync(email_id: int):
    return _change_action_schedule(email_id, True)
