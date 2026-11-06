"""Whole-message context: body and attachments share one account-local scope.

Cataloging is local and never invokes a model. Reading happens only on an ask;
failures remain explicit evidence gaps instead of silently dropping a file.
"""
from . import assistant_attachments as files, assistant_documents as documents, db

MAX_FILES = 12
MAX_TOTAL_PAGES = 100


def describe(email_id, excluded=None, pinned=False):
    catalog = files.catalog(email_id)
    excluded = {i for i in (excluded or []) if type(i) is int and i >= 0}
    row = db.get_email(email_id)
    from . import config
    limit = max(1800, min(config.LLM_MAX_BODY_CHARS, 20000))
    body_partial = len(row.get('body_text') or '') > limit
    return {'email_id':email_id, 'subject':catalog['subject'],
            'excluded':sorted(excluded), 'pinned':bool(pinned), 'body_partial':body_partial, 'body_limit':limit, 'items':[{**item, 'included':item['index'] not in excluded,
                'status':'pending' if item['supported'] else 'unavailable',
                'detail':item['reason']} for item in catalog['items']]}


def resolve(payload):
    """Explicit file tasks and mailbox searches retain their existing behavior."""
    if not payload.include_mail_attachments or payload.attachments or payload.search_mode or payload.alert_context or len(payload.email_ids or []) != 1:
        return None
    email_id = payload.email_ids[0]
    chosen = payload.mail_context
    if not chosen and payload.conversation_id:
        previous = db.get_assistant_mail_context(payload.conversation_id)
        if previous and previous['email_id']==email_id:
            return describe(email_id, previous['excluded'], previous.get('pinned',False))
    if chosen and chosen.email_id != email_id:
        # A natural-language scope change must not reuse another mail's exclusions.
        chosen = None
    return describe(email_id, chosen.excluded if chosen else [], chosen.pinned if chosen else False)


def _gap(context, item, message):
    return {'email_id':context['email_id'], 'index':item['index'], 'name':item['name'],
            'text':'', 'note':message, 'reading':'unavailable', 'unavailable':True,
            'truncated':True, 'image':None, '_auto_mail':True, 'excluded':not item['included']}


def prepare(context, images=None):
    connection = documents.connection_snapshot()
    result, size, pages, count, characters = [], 0, 0, 0, 0
    image_count = len(images or [])
    for item in context['items']:
        if not item['included']:
            item.update(status='excluded', detail='用户已排除此附件，本轮未读取。')
            result.append(_gap(context, item, item['detail']))
            continue
        try:
            if not item['supported']:
                raise ValueError(item['reason'])
            if count >= MAX_FILES:
                raise ValueError('本轮附件读取数量已达上限，余下文件未读取；可排除其他文件后继续核对。')
            ref = documents.reference(context['email_id'], item['index'])
            if size + ref['size'] > files.MAX_TOTAL:
                raise ValueError('本轮附件超过合计 20 MB 的读取范围，此文件未读取。')
            if pages + (ref.get('page_count') or 0) > MAX_TOTAL_PAGES:
                raise ValueError('本轮 PDF 超过合计 100 页的读取范围，此文件未读取。')
            visual = files.kind(ref['name']) in ('png','jpg','jpeg','webp')
            if visual and (not connection['vision'] or image_count >= 3):
                raise ValueError('当前模型无法读取此图片，或本轮图片已达上限；图片内容未读取。')
            value = documents.prepare([{key:ref[key] for key in ('email_id','index','digest')}], context=connection)[0]
            if characters + len(value.get('text') or '') > documents.MAX_SOURCE_TEXT:
                raise ValueError('本轮附件文字超过合计 30 万字符的读取范围，此文件未读取。')
            characters += len(value.get('text') or '')
            size += ref['size']; pages += ref.get('page_count') or 0; count += 1
            image_count += int(visual)
            value['_auto_mail'] = True
            item.update(status='prepared', detail=value['note'])
            result.append(value)
        except ValueError as exc:
            item.update(status='unavailable', detail=str(exc))
            result.append(_gap(context, item, str(exc)))
    # No original bytes, extracted text or credentials are part of the catalog.
    for value in result:
        value['_connection'] = connection
    return result


def coverage(materials):
    return [{'index':item['index'], 'name':item['name'],
             'status':'excluded' if item.get('excluded') else 'unavailable' if item.get('unavailable') else 'partial' if item.get('truncated') else 'read',
             'detail':item['note']} for item in materials if item.get('_auto_mail')]


def read(question, materials, connection):
    """A failed automatic file must not discard successfully read materials."""
    for number, item in enumerate(materials, 1):
        if item.get('unavailable'):
            continue
        try:
            yield from documents.read_for_question(question, [item], connection, start=number)
        except Exception:
            # Do not expose provider transport details or claim the file was read.
            item.update(text='', note='此附件读取未完成，本轮不能据此下结论；请重试或单独核对原件。',
                        unavailable=True, truncated=True, reading='unavailable', image=None)
            for key in ('_pdf','chunks','lookup_text','file_part'):
                item.pop(key, None)
