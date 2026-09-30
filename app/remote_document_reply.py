"""Explicit WeChat document filling backed by the desktop planning/draft flow."""
from __future__ import annotations

import hashlib
import html
import json
import re
import secrets
import time

from . import assistant_document_reply, db

_START = re.compile(r'^(?:帮我|请|麻烦)?(?:填写|填好)(?:当前|这封邮件的|这封)?(?:附件|表格|文档)(?:(?:并|然后)?回复(?:这封邮件)?)?(?:[：:]\s*(.*))?$')
_PICK = re.compile(r'^填写附件第\s*(\d+)\s*个(?:[：:]\s*(.*))?$')
_FIELD = re.compile(r'^填写字段\s*(\d+)\s*[：:]\s*(.+)$', re.S)
_INFO = re.compile(r'^填写信息\s*[：:]\s*(.+)$', re.S)
_ROW = re.compile(r'^选择填写第\s*(\d+)\s*行$')
_COMMANDS = {'填写预览', '生成附件回复', '查看填写结果', '取消填写'}


def matches(text: str) -> bool:
    return bool(text in _COMMANDS or _START.fullmatch(text) or _PICK.fullmatch(text)
                or _FIELD.fullmatch(text) or _INFO.fullmatch(text) or _ROW.fullmatch(text))


def _plan_view(plan):
    lines = [f'小邮 · 待填写字段（{plan["name"]}）']
    for number, field in enumerate(plan['fields'], 1):
        value = field.get('value') or '待补充'
        lines.append(f'{number}. {field["label"]}：{value}（{field.get("location_label") or field["cell"]}）')
    lines.append('发送“填写信息：姓名张三，电话……”让小邮从你的描述中提取；'
                 '或发送“填写字段1：张三”逐项修改。核对后发送“生成附件回复”。')
    return '\n'.join(lines)


def draft_digest(draft):
    """Bind the WeChat confirmation to the exact reviewed draft and file."""
    keys = ('to_addr', 'cc_addr', 'bcc_addr', 'subject', 'body_html', 'reply_to_email_id',
            'in_reply_to', 'references')
    attachments = [(item.get('filename'), item.get('sha256'), item.get('data_base64'))
                   for item in draft.get('attachments') or [] if isinstance(item, dict)]
    data = [draft.get(key) for key in keys] + [attachments]
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _current(state):
    plan = state.get('document_plan')
    if not plan or time.time() - plan.get('created', 0) > 3600 or plan.get('email_id') != state.get('selected'):
        state.pop('document_plan', None)
        state.pop('document_row_options', None)
        return None
    row = db.get_email(plan['email_id'])
    if not row or row.get('remote_missing') or row.get('status') in ('trash', 'quarantine'):
        state.pop('document_plan', None)
        return None
    return plan


def command(state, text, user, channel):
    if not matches(text):
        return None
    if channel != 'weixin':
        return '附件填写目前支持微信单聊和电脑端。'
    if text == '取消填写':
        state.pop('document_plan', None)
        state.pop('document_row_options', None)
        state.pop('pending', None)
        state.pop('prepared_draft_id', None)
        return '已退出附件填写。已生成的草稿仍保存在电脑端草稿箱，未发送邮件。'
    if text == '查看填写结果':
        draft_id = state.get('prepared_draft_id')
        draft = db.get_draft(draft_id) if draft_id else None
        att = db.get_sent_attachment(draft_id, 0, draft=True) if draft else None
        if not att or draft.get('reply_to_email_id') != state.get('selected'):
            return '当前没有可查看的填写结果，请先生成附件回复。'
        state['_media_request'] = {'account_id': state['account_id'], 'draft_id': draft_id,
                                   'digest': hashlib.sha256(att['payload']).hexdigest(), 'mode': 'file'}
        return f'正在通过微信发送填写结果：{att["name"]}。请预览文件；邮件尚未发送。'
    if text == '填写预览':
        plan = _current(state)
        return _plan_view(plan) if plan else '没有有效的填写计划。请先查看邮件，再说“填写附件”。'
    row_choice = _ROW.fullmatch(text)
    if row_choice:
        options = state.get('document_row_options')
        if not options or options.get('email_id') != state.get('selected') or time.time() - options.get('created', 0) > 3600:
            return '没有可选择的表格行。请重新说“填写附件”。'
        selected = int(row_choice[1])
        if selected not in {item['row'] for item in options['choices']}:
            return '行号无效，请按刚才展示的行号选择。'
        try:
            plan = assistant_document_reply.plan(options['email_id'], options['index'],
                                                 options['instruction'], row_choice=selected)
        except ValueError as exc:
            return str(exc)
        state['document_plan'] = {**plan, 'instruction': options['instruction'], 'created': time.time()}
        state.pop('document_row_options', None)
        return _plan_view(state['document_plan'])
    start, pick = _START.fullmatch(text), _PICK.fullmatch(text)
    if start or pick:
        row = db.get_email(state.get('selected')) if state.get('selected') else None
        if not row or row.get('remote_missing') or row.get('status') in ('trash', 'quarantine'):
            return '请先查看一封可用邮件，再说“填写附件”。'
        from .remote_media import _attachments
        files = _attachments(row)
        supported = [(index, item) for index, item in enumerate(files)
                     if str(item.get('name') or '').lower().endswith(('.xls', '.xlsx', '.docx', '.pdf'))]
        if not supported:
            return '这封邮件没有可填写的 XLS、XLSX、DOCX 或 PDF 附件。'
        if pick:
            index = int(pick[1]) - 1
            if index not in dict(supported):
                return '附件序号不可填写；请说“填写附件”查看可选项。'
        elif len(supported) != 1:
            return '这封邮件有多个可填写附件：\n' + '\n'.join(
                f'{index+1}. {str(item.get("name") or "未命名")[:120]}' for index, item in supported[:20]) + \
                '\n发送“填写附件第 1 个”选择。'
        else:
            index = supported[0][0]
        # A new fill request supersedes any previous preview or send confirmation.
        state.pop('document_plan', None)
        state.pop('document_row_options', None)
        state.pop('pending', None)
        state.pop('prepared_draft_id', None)
        instruction = ((pick[2] if pick else start[1]) or '').strip()[:1000]
        try:
            plan = assistant_document_reply.plan(row['id'], index, instruction)
        except ValueError as exc:
            return str(exc)
        if plan.get('needs_row_choice'):
            state['document_row_options'] = {**plan, 'instruction': instruction, 'created': time.time()}
            return ('此表格需要选择填写行：\n' + '\n'.join(
                f'{item["row"]}. {item["label"]}' for item in plan['choices'][:30]) +
                '\n发送“选择填写第 3 行”这样的指令；仅写入所选行。')
        state['document_plan'] = {**plan, 'instruction': instruction, 'created': time.time()}
        state['context_at'] = time.time()
        return _plan_view(state['document_plan'])
    plan = _current(state)
    if not plan:
        return '没有有效的填写计划。请先查看邮件，再说“填写附件”。'
    field = _FIELD.fullmatch(text)
    if field:
        number, value = int(field[1]), field[2].strip()
        if not 1 <= number <= len(plan['fields']) or not value or len(value) > 500:
            return '字段序号或内容无效。请输入“填写预览”核对。'
        plan['fields'][number-1]['value'] = value
        return _plan_view(plan)
    info = _INFO.fullmatch(text)
    if info:
        try:
            result = assistant_document_reply.suggest_values(plan['email_id'], plan['index'], plan['digest'],
                                                               plan['fields'], plan['plan_token'], info[1][:3000])
        except ValueError as exc:
            return str(exc)
        count = 0
        for field, value in zip(plan['fields'], result['values']):
            if value and not field.get('value'):
                field['value'] = value
                count += 1
        return f'已提取 {count} 项，请核对：\n' + _plan_view(plan)
    if text == '生成附件回复':
        missing = [str(number) for number, field in enumerate(plan['fields'], 1) if not str(field.get('value') or '').strip()]
        if missing:
            return '字段 ' + '、'.join(missing) + ' 尚未填写。请发送“填写字段序号：实际内容”；不适用可填“无”。'
        try:
            result = assistant_document_reply.prepare(plan['email_id'], plan['index'], plan['digest'],
                                                      plan['fields'], plan['instruction'], plan['plan_token'])
        except ValueError as exc:
            return str(exc)
        draft = db.get_draft(result['draft_id'])
        token = secrets.token_hex(4).upper()
        state['prepared_draft_id'] = result['draft_id']
        state['pending'] = {'draft_id': result['draft_id'], 'email_id': plan['email_id'],
                            'digest': draft_digest(draft), 'token': token, 'expires': time.time() + 600}
        state.pop('document_plan', None)
        body = html.unescape(re.sub(r'(?i)<br\s*/?>', '\n', re.sub(r'<[^>]+>', '', draft['body_html'])))
        return (f'回复预览（尚未发送）\n收件人：{draft["to_addr"]}\n主题：{draft["subject"]}\n'
                f'附件：{result["filename"]}\n\n正文：\n{body[:3000]}\n\n'
                f'发送“查看填写结果”获取并检查附件。核对无误后，复制并发送：\n确认发送 {token}\n'
                '也可在电脑端草稿箱修改；10 分钟后本次微信确认失效。')
    return None
