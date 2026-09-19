"""Common queries must keep their subject instead of becoming generic help/tasks."""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import mail_assistant as assistant


def main():
    confirmed = {'id': 1, 'score': 90, 'verdict': 'clean', 'feedback': 'fp', 'reviewed': 1}
    missed = {'id': 2, 'score': 0, 'verdict': 'clean', 'feedback': 'fn'}
    assert not assistant.needs_risk_attention(confirmed)
    assert assistant.needs_risk_attention(missed)
    assert assistant.needs_risk_attention({'score': 40, 'verdict': 'suspicious'})
    assert assistant.risk_alert_level({'score': 40, 'verdict': 'suspicious'}) == 'suspicious'
    assert assistant.risk_alert_level({'score': 70, 'verdict': 'suspicious'}) == 'high'
    assert assistant.risk_alert_level({'score': 10, 'verdict': 'phishing'}) == 'high'
    assert '用户确认误报' in assistant.risk_context(confirmed)
    with patch.object(assistant.db, 'list_emails', return_value=[confirmed, missed]), \
         patch.object(assistant.db, 'get_runtime_settings', return_value={}), \
         patch.object(assistant.db, 'set_runtime_setting'), \
         patch.object(assistant.db, 'list_todos', return_value=[]):
        alert = assistant.alerts()
        assert alert['risk_count'] == 1 and alert['items'][0]['id'] == 2
        assert alert['new_high_risk_count'] == 0  # Existing messages establish a quiet baseline.
        assert alert['new_suspicious_count'] == 0
        assert not alert['new_items']
    assert assistant._direct_answer('你能做什么？')
    assert '小邮' in assistant.RESPONSE_FORMAT
    assert '不要机械套用固定栏目' in assistant.RESPONSE_FORMAT
    assert assistant._direct_answer('请问怎么用？')
    assert assistant._direct_answer('ERP系统怎么用？') is None
    assert assistant._direct_answer('这个项目支持哪些接口？') is None
    with patch.object(assistant.db, 'list_todos', return_value=[]) as todos:
        for question in ('这封钓鱼邮件怎么处理？', 'ERP项目任务是什么？', '证书过期怎么处理？'):
            assert assistant._todo_answer(question) is None
        todos.assert_not_called()
        for question in ('今天有什么要处理？', '哪些任务已经过期？', '查看待办清单', '逾期任务'):
            assert assistant._todo_answer(question)
    row = {'id': 744, 'subject': 'Selected mail'}
    with patch.object(assistant.db, 'get_email', return_value=row) as get, \
         patch.object(assistant.db, 'search_emails') as search:
        assert assistant.retrieve('第744封为什么有风险？') == [row]
        get.assert_called_once_with(744)
        search.assert_not_called()
    named = {'id': 1, 'from_name': '姜超', 'subject': '项目进展', 'date': '2026-08-31'}
    with patch.object(assistant.db, 'search_emails', return_value=[named]), \
         patch.object(assistant.db, 'list_emails') as listing:
        assert assistant.retrieve('总结姜超最近三封邮件的重点') == [named]
        listing.assert_not_called()
    high = {'id': 2, 'priority': '高', 'subject': '紧急合同', 'date': '2026-09-03'}
    normal = {'id': 3, 'priority': '中', 'subject': '例会', 'date': '2026-09-03'}
    with patch.object(assistant.db, 'list_emails', return_value=[normal, high]), \
         patch.object(assistant.db, 'get_email', return_value=high) as get, \
         patch.object(assistant.db, 'search_emails') as search:
        assert assistant.retrieve('优先级高的邮件') == [high]
        assert assistant.retrieve('总结最近的重要邮件') == [high]
        search.assert_not_called()
        assert all(call.args == (2,) for call in get.call_args_list)
    assert '暂时没找到' in assistant._empty_answer('找王老师的邮件')
    assert '没有在当前邮箱的本地邮件中找到足够相关的信息' not in assistant._empty_answer('找王老师的邮件')
    with patch.object(assistant.config, 'LLM_PROVIDER', 'kimi_code'), patch.object(assistant.config, 'LLM_MODEL', 'kimi-for-coding'):
        assert assistant._assistant_request_limits() == (4096, 90)
    with patch.object(assistant.config, 'LLM_PROVIDER', 'deepseek'), patch.object(assistant.config, 'LLM_MODEL', 'deepseek-chat'):
        assert assistant._assistant_request_limits() == (1600, 60)
    assert '先直接给出是否一致及差额' in assistant._question_instruction('明细加起来确实是账单金额吗？')
    assert not assistant._question_instruction('总结这封邮件')
    # 公司内部模型模式保留邮件原文，且不再固定截断在旧的 1800 字位置。
    private_row = {**named, 'body_text': '说明' * 1000 + '联系电话13812345678',
                   'summary': '', 'snippet': '', 'score': 0, 'verdict': 'clean'}
    captured = {}
    def private_stream(messages, **kwargs):
        captured['messages'] = messages
        return iter(['联系电话已读取 [email_id:1]'])
    with patch.object(assistant, 'retrieve', return_value=[private_row]), \
         patch.object(assistant.client, 'available', return_value=True), \
         patch.object(assistant.client, 'chat_completion_stream', side_effect=private_stream), \
         patch.object(assistant.config, 'REDACT_BEFORE_LLM', False), \
         patch.object(assistant.config, 'LLM_MAX_BODY_CHARS', 6000):
        list(assistant.ask_stream('联系电话是什么'))
    model_context = str(captured['messages'])
    assert '13812345678' in model_context and '[手机号]' not in model_context
    budget = {}
    def kimi_stream(messages, **kwargs):
        budget.update(kwargs); budget['messages'] = messages
        return iter(['明细合计与账单一致 [email_id:1]'])
    with patch.object(assistant, 'retrieve', return_value=[private_row]), \
         patch.object(assistant.client, 'available', return_value=True), \
         patch.object(assistant.client, 'chat_completion_stream', side_effect=kimi_stream), \
         patch.object(assistant.config, 'LLM_PROVIDER', 'kimi_code'), \
         patch.object(assistant.config, 'LLM_MODEL', 'kimi-for-coding'):
        answer_events = list(assistant.ask_stream('明细加起来确实是账单金额吗？'))
    assert budget['max_tokens'] == 4096 and budget['timeout'] == 90
    assert '先直接给出是否一致及差额' in str(budget['messages'])
    assert '明细合计与账单一致' in ''.join(value for event,value in answer_events if event == 'delta')
    event_kinds = [event for event, _ in answer_events]
    status_states = [value['state'] for event, value in answer_events if event == 'status']
    assert 'searching' in status_states and 'analyzing' in status_states
    analyzing_index = next(index for index, (event, value) in enumerate(answer_events)
                           if event == 'status' and value['state'] == 'analyzing')
    assert event_kinds.index('sources') < analyzing_index < event_kinds.index('delta')
    analyzing = next(value for event, value in answer_events if event == 'status' and value['state'] == 'analyzing')
    assert '已找到 1 封相关邮件' in analyzing['message'] and analyzing['detail']
    assert analyzing['message_en'] and analyzing['detail_en']
    with patch.object(assistant, 'retrieve', return_value=[named]), \
         patch.object(assistant.client, 'available', return_value=True), \
         patch.object(assistant.client, 'chat_completion_stream', side_effect=lambda messages, **kwargs: (retry_messages.append(messages) or iter(['半句']))), \
         patch.object(assistant.client, 'chat_completion', return_value=None), \
         patch.object(assistant.time, 'sleep'):
        retry_messages = []
        events = list(assistant.ask_stream('总结姜超的邮件'))
        answer = ''.join(value for event, value in events if event == 'delta')
        assert '半句' not in answer and '项目进展' in answer
        assert any(event == 'status' and value['state'] == 'retrying' for event, value in events)
        assert any(event == 'status' and value['state'] == 'fallback' for event, value in events)
        assert any('模型本次未能完成回答' in value for event, value in events if event == 'delta')
        assert len(retry_messages) == 2 and '总字数不超过200字' in retry_messages[1][-1]['content']
        assert len([value for event, value in events if event == 'delta']) > 1
    print('Assistant help, risk-vs-task, explicit source and named recent query routing passed')


if __name__ == '__main__':
    main()
