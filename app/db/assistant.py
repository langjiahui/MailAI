"""小邮助手会话存储与 AI 分析结果缓存。"""
import json
from datetime import datetime

from .core import conn
from .emails import get_email


def get_ai_analysis_cache(cache_key: str) -> dict | None:
    """Return one reusable model result; corrupt cache entries fail closed."""
    with conn() as c:
        row = c.execute(
            "SELECT result FROM ai_analysis_cache WHERE cache_key=?", (cache_key,)
        ).fetchone()
    if not row:
        return None
    try:
        value = json.loads(row["result"])
        return value if isinstance(value, dict) else None
    except (TypeError, ValueError):
        return None


def save_ai_analysis_cache(cache_key: str, kind: str, model: str, result: dict):
    with conn() as c:
        c.execute(
            "INSERT INTO ai_analysis_cache(cache_key,kind,model,result,created_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(cache_key) DO UPDATE SET result=excluded.result,created_at=excluded.created_at",
            (cache_key, kind, model, json.dumps(result, ensure_ascii=False),
             datetime.now().isoformat(timespec="seconds")),
        )


def create_assistant_conversation(title: str) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute("INSERT INTO assistant_conversations(title,created_at,updated_at) VALUES(?,?,?)",
                        ((title or "新对话")[:60], now, now))
        return cur.lastrowid


def set_assistant_alert_context(conversation_id: int, ids):
    with conn() as c:
        c.execute('UPDATE assistant_conversations SET alert_email_ids=? WHERE id=?',
                  (json.dumps(list(dict.fromkeys(ids or []))[:20]), conversation_id))


def assistant_alert_context(conversation_id: int, messages) -> dict:
    from ..mail_assistant import needs_risk_attention
    with conn() as c:
        row = c.execute('SELECT alert_email_ids FROM assistant_conversations WHERE id=?', (conversation_id,)).fetchone()
    ids = json.loads(row['alert_email_ids'] or '[]') if row else []
    # Recognize previously generated reminder analyses without touching user chats.
    if not ids and messages and messages[0]['content'].startswith('请只分析这次提醒的新增邮件（共') \
            and sum(m['role'] == 'user' for m in messages) == 1:
        ids = list(dict.fromkeys(s['id'] for m in messages for s in m.get('sources', []) if s.get('id')))[:20]
    pending = []
    for email_id in ids:
        email = get_email(email_id)
        if email and needs_risk_attention(email):
            pending.append(email_id)
    return {'alert_email_ids': ids, 'pending_alert_ids': pending}


def add_assistant_message(conversation_id: int, role: str, content: str, sources: list | None = None, images=None):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute("INSERT INTO assistant_messages(conversation_id,role,content,sources,created_at) VALUES(?,?,?,?,?)",
                  (conversation_id, role, content, json.dumps(sources or [], ensure_ascii=False), now))
        message_id = cur.lastrowid
        for image in images or []:
            c.execute("INSERT INTO assistant_images(message_id,mime,payload,thumbnail) VALUES(?,?,?,?)",
                      (message_id, image['history_mime'], image['history_data'], image['thumbnail']))
        c.execute("UPDATE assistant_conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return message_id


def list_assistant_conversations(limit: int = 50):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT c.*,COUNT(m.id) AS message_count FROM assistant_conversations c "
            "LEFT JOIN assistant_messages m ON m.conversation_id=c.id GROUP BY c.id "
            "ORDER BY c.updated_at DESC LIMIT ?", (max(1, min(limit, 100)),)
        ).fetchall()]


def get_assistant_messages(conversation_id: int):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY id", (conversation_id,)
        ).fetchall()]
        images = c.execute("SELECT i.id,i.message_id FROM assistant_images i JOIN assistant_messages m "
                           "ON m.id=i.message_id WHERE m.conversation_id=? ORDER BY i.id", (conversation_id,)).fetchall()
    by_message = {}
    for image in images:
        path = f"/api/assistant/images/{image['id']}"
        by_message.setdefault(image['message_id'], []).append({'url': path, 'thumbnail_url': path + '?thumbnail=true'})
    for row in rows:
        row['images'] = by_message.get(row['id'], [])
        try:
            row["sources"] = json.loads(row.get("sources") or "[]")
        except json.JSONDecodeError:
            row["sources"] = []
    return rows


def get_assistant_image(image_id: int, thumbnail=False):
    # Select only the requested representation, never all image BLOBs in a chat.
    column = 'thumbnail' if thumbnail else 'payload'
    with conn() as c:
        row = c.execute(f"SELECT mime,{column} AS data FROM assistant_images WHERE id=?", (image_id,)).fetchone()
    return dict(row) if row else None


def assistant_conversation_exists(conversation_id: int) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM assistant_conversations WHERE id=?", (conversation_id,)).fetchone() is not None
