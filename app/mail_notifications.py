"""Shared native mail previews; mail content remains literal, never UI copy."""
import hashlib
import json
import re

from .ui_copy import ui_format, ui_language, ui_text


def clean_line(value, limit=180):
    # Subject headers can contain folding, control characters or bidi overrides.
    text = re.sub(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', ' ', str(value or ''))
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def notification_target(result):
    mail = result.get('mail') or {}
    if not isinstance(mail, dict):
        return None
    account = result.get('account_id')
    email_id = mail.get('id')
    if (result.get('fetched') != 1 or not isinstance(account, str) or not account
            or type(email_id) is not int or email_id <= 0):
        return None
    return {'accountId': account, 'emailId': email_id}


def notification_key(target):
    """Bounded native identifiers; account-local IDs must never collide."""
    return hashlib.sha256(json.dumps(target, sort_keys=True).encode()).hexdigest()[:32]


def notification_text(result):
    if not result or not result.get('ok') or result.get('canceled') or result.get('notifications_delivered'):
        return None
    fetched = max(0, int(result.get('fetched') or 0))
    if not fetched:
        return None
    quarantined = max(0, int(result.get('quarantined') or 0))
    errors = max(0, int(result.get('errors') or 0))
    details = []
    if quarantined:
        details.append(ui_format('其中 {0} 封需要安全关注', quarantined))
    if errors:
        details.append(ui_format('{0} 封将在下次同步时重试', errors))
    account = clean_line(result.get('account_user'), 100)
    mail = result.get('mail')
    if fetched == 1 and isinstance(mail, dict):
        title = clean_line(mail.get('subject')) or ui_text('（无主题）')
        sender = clean_line(mail.get('from_name') or mail.get('from_addr'), 100) or ui_text('未知发件人')
        context = ' · '.join(item for item in (account, *details) if item)
        return title, sender + ('\n' + context if context else '')
    title = ui_format('收到 {0} 封新邮件', fetched)
    body = ('; ' if ui_language() == 'en' else '，').join(details) or ui_text('邮件已同步，请打开 MailAI 查看')
    return title, (account + ' · ' if account else '') + body
