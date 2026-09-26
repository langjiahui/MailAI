"""待办与提醒。"""
import json
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException

from ... import db, system_settings
from ..schemas import TodoBulkStatusRequest, TodoUpdateRequest

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/todos")
def api_todos(include_done: bool = False):
    return db.list_todos(include_done)


@router.post("/api/todos/bulk/status")
def api_todos_bulk_status(payload: TodoBulkStatusRequest):
    if payload.status not in {"open", "done"}:
        raise HTTPException(400, "待办状态仅支持 open 或 done")
    ids = sorted({todo_id for todo_id in payload.ids if todo_id > 0})
    if not ids:
        raise HTTPException(400, "请选择待办事项")
    return {"ok": True, "updated": db.set_todos_status(ids, payload.status)}


@router.post("/api/todos/{todo_id}/done")
def api_todo_done(todo_id: int):
    db.set_todo_status(todo_id, "done")
    return {"ok": True}


@router.post("/api/todos/{todo_id}/reopen")
def api_todo_reopen(todo_id: int):
    db.set_todo_status(todo_id, "open")
    return {"ok": True}


@router.patch("/api/todos/{todo_id}")
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
    from ... import task_planner
    try:
        return {"ok": True, 'task': task_planner.save(todo_id=todo_id, **payload.model_dump(exclude_none=True))}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post('/api/emails/{email_id}/todo')
def api_email_todo(email_id: int, payload: TodoUpdateRequest | None = None):
    from ... import task_planner
    try:
        return {'ok': True, 'task': task_planner.save(email_id=email_id, **(payload.model_dump(exclude_none=True) if payload else {}))}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post('/api/emails/{email_id}/remind')
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
    from ... import task_planner
    try:
        task = task_planner.save(email_id=email_id)
        task = task_planner.save(todo_id=task['id'], remind_at=when.isoformat())
        return {'ok': True, 'todo_id': task['id']}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get('/api/reminders')
def api_reminders():
    reminders = json.loads(db.get_runtime_settings().get('mail_reminders', '{}'))
    return [{'email_id': int(key), **value} for key, value in reminders.items()] + [
        {'email_id':task['email_id'], 'todo_id':task['id'], 'at':task['remind_at'], 'subject':task['title']}
        for task in db.list_todos() if task.get('remind_at')]


@router.delete('/api/task-reminders/{todo_id}')
def api_dismiss_task_reminder(todo_id: int):
    from ... import task_planner
    try:
        task_planner.save(todo_id=todo_id, remind_at='')
        return {'ok': True}
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.delete('/api/reminders/{email_id}')
def api_dismiss_reminder(email_id: int):
    reminders = json.loads(db.get_runtime_settings().get('mail_reminders', '{}'))
    reminders.pop(str(email_id), None)
    db.set_runtime_setting('mail_reminders', json.dumps(reminders, ensure_ascii=False))
    return {'ok': True}


@router.get('/api/reminders/all')
def api_all_reminders():
    from ...account_context import snapshot, use
    items = []
    for account_id, account in system_settings._load_registry().get('accounts', {}).items():
        try:
            with use(snapshot(account_id)):
                items.extend({**item, 'account_id': account_id, 'account_user': account['user']} for item in api_reminders())
        except (ValueError, OSError):
            continue
    return items


@router.get('/api/task-notices')
def api_task_notices():
    from ...task_notifications import reminder_records, capability
    return {'items': reminder_records(), 'capability': capability()}


@router.post('/api/task-notices/test')
def api_test_task_notice():
    from ...task_notifications import capability, deliver
    status = capability()
    if not status['supported']:
        return {'ok':False,'message':status['hint']}
    try:
        ok = deliver('MailAI · 测试提醒', '看到这条通知，说明当前系统允许显示提醒。点击可查看提醒记录。', {'reminderInbox':True})
        return {'ok':bool(ok), 'message':'已提交测试通知；是否显示取决于系统通知权限与勿扰设置。' if ok else '通知暂未提交，请稍后重试。'}
    except Exception:
        log.warning('测试待办通知失败', exc_info=True)
        return {'ok':False,'message':'无法提交系统通知，请检查通知设置。'}
