"""Small contextual next-step suggestions using supported commands, never mail instructions."""
import re
from .remote_commands import canonicalize


def _next(state, task=False):
    ids = state.get('todo_ids' if task else 'ids', [])
    selected = state.get('selected_todo' if task else 'selected')
    if selected in ids and ids.index(selected) + 1 < len(ids):
        return ('看下一项', '下一项') if task else ('看下一封', '下一封')
    return ('回到待办清单', '返回待办') if task else ('回到邮件清单', '返回列表')


def _without_footer(response):
    # Remove only known application-authored guide lines at the end/after a list.
    # Never rewrite the mail body, generated prose, synchronization caveats or send token.
    exact = (
        '输入“查看第一封”阅读，随后可说“下一封”“回复这封”；“查收邮件”收取新邮件。',
        '输入“查看第一项待办”看详情，或“查看第一项原邮件”；可说“下一项”“返回待办”。',
        '输入“查看原邮件”核对，或“回复这封”回复来源邮件；“下一项”“返回待办”继续查看。',
        '输入“回复：你的正文”创建预览，或“起草回复：你的要求”。',
    )
    for footer in exact:
        response = response.removesuffix('\n' + footer)
    response = re.sub(r'\n(?:当前第 \d+ / \d+ 封。)?可说“下一封”“上一封”“返回列表”；“回复这封”输入正文，或“总结这封”（AI）。$', '', response)
    response = response.removesuffix('\n这是当前待办的来源邮件。可说“回复这封”“总结这封”（AI），或“下一项”“返回待办”。')
    return response.rstrip()


def guide(response, request, state):
    """At most two next steps, scoped to the result the user actually requested."""
    command = canonicalize(str(request or '').strip())
    # Existing reply flow already says exactly what to enter, including its one-use code.
    if state.get('pending') or state.get('awaiting_reply') or not command:
        return response
    if response.startswith('手机邮件控制') or re.search(r'^(?:操作未完成|AI 暂不可用|请先在设置|当前未选中|上次邮件上下文|邮件序号无效|邮件当前不可用|原邮件已不可用|这项待办或来源邮件已不可用|待办序号不可用|暂无可返回|确认编号不匹配)', response):
        return response
    if command == '返回列表' and state.get('todo_view'):
        command = '返回待办'
    choices = []
    if command == '今日简报':
        if state.get('ids'):
            choices.append(('展开重要来信', '查看第一封'))
        if state.get('todo_ids'):
            choices.append(('先看今天要处理的事', '查看第一项待办'))
        if not choices:
            choices = [('更新邮箱', '查收邮件'), ('查看所有近期来信', '最新邮件')]
    elif command in ('新邮件', '更多新邮件') or command.startswith('时间邮件 '):
        if '\n小邮 · 新邮件\n' not in response:
            return response
        if state.get('ids'):
            choices.append(('展开这页第一封', '查看第一封'))
        if state.get('phone_page'):
            choices.append(('继续看未展开的来信', '更多新邮件'))
        elif choices:
            choices.append(('看看今天的工作重点', '今天有什么重要的？'))
        else:
            choices = [('先收取服务器上的新邮件', '查收邮件'), ('看看今天的工作重点', '今天有什么重要的？')]
    elif command in ('今天待办', '返回待办'):
        choices = [('展开第一项及来源', '查看第一项待办'), ('查看今天的重要来信', '今天有什么重要的？')] if state.get('todo_ids') else [('查看今天的重要来信', '今天有什么重要的？'), ('更新邮箱', '查收邮件')]
    elif command in ('查看当前待办', '下一项', '上一项') or re.fullmatch(r'查看待办第\s*\d+\s*项', command):
        if state.get('selected_todo'):
            choices = [('核对这项的原邮件', '查看原邮件'), _next(state, True)]
    elif command in ('最新邮件', '未读邮件', '重要邮件', '返回列表'):
        if state.get('ids'):
            choices = [('展开第一封', '查看第一封'), ('看看今天要处理的事', '看看今天待办')]
        else:
            choices = [('更新邮箱', '查收邮件'), ('看看今天要处理的事', '看看今天待办')]
    elif command == '查看当前邮件' or re.fullmatch(r'查看第\s*\d+\s*封|查看待办原邮件第\s*\d+\s*项', command) or command in ('下一封', '上一封'):
        if state.get('selected'):
            choices = [('准备回复，先预览', '回复这封'), _next(state, bool(state.get('todo_view')))]
    elif command.startswith('总结') and state.get('selected'):
        choices = [('按你的要求起草回复', '起草回复：礼貌确认收到') if state.get('_ai_enabled') else ('准备回复，先预览', '回复这封'), ('核对原文', '查看这封')]
    elif command.startswith('确认发送') and response.startswith('邮件服务器已接受回复。'):
        choices = [('继续查看今天的工作重点', '今天有什么重要的？'), ('查看新增来信', '有什么新邮件？')]
    if not choices:
        return response
    return _without_footer(response) + '\n\n接下来可以说：\n' + '\n'.join(f'• {label}：“{text}”' for label, text in choices[:2])
