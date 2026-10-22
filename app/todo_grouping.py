"""Non-destructive task grouping. Related notices retain every source and edit."""
from datetime import datetime
from email.utils import parseaddr
import re
import unicodedata


_PREFIX = re.compile(r'^(?:(?:re|fw|fwd|回复|转发|更正|更新|补充|修订)\s*[:：]\s*|(?:请以此(?:封)?邮件为准)[!！:：，,。\s]*|[【\[](?:更正|更新|补充|修订)[】\]]\s*)', re.I)
_REVISION = re.compile(r'^(?:请以此(?:封)?邮件为准|(?:更正|修订|补充|更新)\s*[:：]|[【\[](?:更正|修订|补充|更新)[】\]])')


def subject_key(subject):
    value = unicodedata.normalize('NFKC', subject or '').strip()
    while True:
        stripped = _PREFIX.sub('', value, count=1).strip()
        if stripped == value:
            return value
        value = stripped


def _timestamp(value):
    try:
        parsed = datetime.fromisoformat(value or '')
        # Only compare intervals here; dates never change a task's deadline.
        return parsed.timestamp()
    except (ValueError, TypeError):
        return None


def annotate(rows):
    """Only explicit threads or exact corrected subjects link different emails.

    Matching is account-local. Independent deadlines, stages and kinds stay in
    separate groups; orphaned tasks never collapse into one anonymous group.
    """
    emails = {}
    for row in rows:
        if row.get('email_id'):
            emails.setdefault(row['email_id'], row)
    parents = {key: key for key in emails}

    def root(key):
        while parents[key] != key:
            key = parents[key]
        return key

    def join(a, b):
        a, b = root(a), root(b)
        parents[max(a, b)] = min(a, b)

    threads, subjects = {}, {}
    # Bound revision clusters by their newest notice, avoiding a chain across
    # recurring weekly events that happen to reuse the same subject.
    ordered = sorted(emails.items(), key=lambda pair: _timestamp(pair[1].get('email_date')) or 0, reverse=True)
    for key, row in ordered:
        sender = parseaddr(row.get('email_from') or '')[1].casefold()
        thread = (row.get('email_thread') or '').strip()
        if thread and sender:
            match = (thread, sender)
            if match in threads:
                join(key, threads[match])
            else:
                threads[match] = key
        title = subject_key(row.get('email_subject'))
        stamp = _timestamp(row.get('email_date'))
        if len(title) < 8 or not sender or stamp is None:
            continue
        match = (sender, title.casefold())
        revision_subject = re.sub(r'^(?:(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+', '', row.get('email_subject') or '', flags=re.I)
        revision = bool(_REVISION.search(revision_subject))
        candidates = subjects.setdefault(match, [])
        candidate = next((value for value in candidates
                          if abs(stamp - value[1]) <= 7 * 86400 and (revision or value[2])), None)
        if candidate:
            join(key, candidate[0])
            if revision and not candidate[2]:
                candidates[candidates.index(candidate)] = (candidate[0], candidate[1], True)
        else:
            candidates.append((key, stamp, revision))
    result = []
    for row in rows:
        email_id = row.get('email_id')
        owner = root(email_id) if email_id in parents else None
        scope = f'mail:{owner}' if owner is not None else f'task:{row["id"]}'
        # A stable key, independent of which subtask is completed/filtered out.
        key = '|'.join((scope, str(row.get('deadline') or '')[:10],
                        row.get('stage') or 'active', row.get('kind') or 'execution'))
        result.append({**row, 'group_key': key,
                       'group_title': subject_key(row.get('email_subject')) or row['title']})
    return result
