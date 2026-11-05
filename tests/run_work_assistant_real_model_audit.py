"""Opt-in real-model acceptance using synthetic work mail in a temporary store."""
import argparse
import json
import re
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    from app import config, db, work_assistant as work, companion_growth
    from app.account_context import use
    from app.llm import client
    from app.web.routes.compose import api_compose_assist
    from app.web.schemas import ComposeAssistRequest
    if not client.available():
        raise SystemExit('No real model configured')
    report = {'provider': config.LLM_PROVIDER, 'model': config.LLM_MODEL,
              'synthetic_data_only': True, 'cases': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def run(name, action, check):
        started = time.monotonic()
        try:
            value = action()
            problems = check(value)
        except Exception as exc:
            value, problems = None, [f'{type(exc).__name__}: {exc}']
        row = dict(name=name, seconds=round(time.monotonic()-started, 2),
                   problems=problems, result=value)
        report['cases'].append(row)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)

    with tempfile.TemporaryDirectory(prefix='mailai-work-live-') as folder, use({
        'ACCOUNT_ID': 'synthetic-work-live', 'DB_PATH': str(Path(folder)/'mail.db'),
        'DATA_DIR': folder, 'USER_DATA_DIR': folder, 'IMAP_USER': 'me@example.test',
        'RAW_DIR': str(Path(folder)/'raw'), 'SEMANTIC_ENABLED': False,
    }), patch.object(companion_growth, 'safe_record'):
        db.init_db()
        first = db.upsert_email(dict(uid=1, message_id='<work-root@example.test>',
            thread_id='<work-root@example.test>', from_addr='supplier@example.test',
            subject='测试项目交付确认', status='inbox', verdict='clean',
            date='2026-11-05T09:00:00',
            body_text='请确认交付日期。请提供实施人员名单。是否需要现场培训？'))
        db.upsert_email(dict(uid=2, message_id='<work-change@example.test>',
            thread_id='<work-root@example.test>', in_reply_to='<work-root@example.test>',
            from_addr='supplier@example.test', subject='回复：测试项目交付确认',
            status='inbox', verdict='clean', date='2026-11-05T10:00:00',
            body_text='交付日期现调整到2026年12月21日，请以此为准。'))
        unrelated = db.upsert_email(dict(uid=3, message_id='<other@example.test>',
            thread_id='<other@example.test>', from_addr='other@example.test',
            subject='另一项目', body_text='另一个项目预算86421.49元。核对码OTHER86421。',
            date='2026-11-05T11:00:00', status='inbox', verdict='clean'))
        work.save_context(first, project='测试项目', role='汇总人员名单，不负责审批',
                          note='名单尚待确认，无权承诺额外预算或提交日期。')
        work.save_context(unrelated, project='另一项目', note='预算86421.49元。OTHER86421。')
        work.save_preferences('先写结论，正文简洁，不写敬礼或身份落款。')
        revision = db.mailbox_revision()

        def missing_check(value):
            quotes = '\n'.join(row['question'] for row in value['items'])
            return ([f'Missing omission: {word}' for word in ('人员名单', '现场培训') if word not in quotes]
                    + ([] if any(row['kind']=='attachment' for row in value['items']) else ['Missing attachment warning'])
                    + ([] if value['model_used'] else ['No live model review']))
        run('missing_questions_and_attachment',
            lambda: work.review(first,'交付日期已确认，详见附件。',[],semantic=True), missing_check)
        complete_text = '交付日期按最新来信为2026年12月21日。实施人员名单为赵森、唐晓。本次需要现场培训，具体安排待双方确认。'
        run('conflicting_memory_needs_review', lambda: work.review(first,complete_text,
            [],semantic=True), lambda value: [] if any(row['kind']=='uncertain' and '人员名单' in row['question'] for row in value['items']) else ['Conflicting saved context not surfaced'])
        work.save_context(first,project='测试项目',role='汇总人员名单，不负责审批',
            note='已确认名单为赵森、唐晓。本次需要现场培训，具体安排待双方确认。交付日期按供应方最新通知。',revision=1)
        run('complete_reply', lambda: work.review(first,
            '交付日期按最新来信为2026年12月21日。实施人员名单为赵森、唐晓。本次需要现场培训，具体安排待双方确认。',
            [],semantic=True), lambda value: [] if value['model_used'] and not value['items'] else ['Answered questions incorrectly flagged'])
        work.save_context(first,project='测试项目',role='汇总人员名单，不负责审批',
            note='名单尚待确认，无权承诺额外预算或提交日期。',revision=2)

        def reply_check(value):
            body = value['content']
            problems = []
            if not re.search(r'12(?:月|[-/])21', body): problems.append('Latest delivery date absent')
            if '名单' not in body or not re.search(r'待|尚|确认|后续',body): problems.append('Pending list absent')
            if any(word in body for word in ('86421','OTHER86421','敬礼')): problems.append('Unrelated facts or ignored style')
            if re.search(r'已(?:经)?(?:确认并)?同意|已批准|我方承诺|保证履行|汇总中|内部尚在评估|已核实|无法承诺提供时间|无权审批',body): problems.append('Invented decision/state or internal constraints exposed to recipient')
            if '关联往来与事项记录' not in value['basis'] or '写作偏好' not in value['basis']: problems.append('Missing allowed context')
            if any(not item['found_in_reference'] for item in value['checks'] if re.search(r'12(?:月|[-/])21',item['text'])): problems.append('Linked reference date incorrectly flagged')
            return problems
        run('reply_with_latest_context_and_preferences', lambda: api_compose_assist(ComposeAssistRequest(
            operation='reply', source_email_id=first, use_work_preferences=True,
            subject='Re: 测试项目交付确认', recipients='supplier@example.test',
            user_instruction='按最新来信回复交付日期，说明名单尚待确认；不要承诺提供时间。',
            original_text=db.get_email(first)['body_text'])), reply_check)

        sent = db.create_sent_message(dict(to_addr='supplier@example.test',from_addr='me@example.test',
            subject='实施人员名单反馈',body_html='<p>请协助反馈实施人员名单。</p>',mode='compose'))
        db.finish_sent_message(sent,ok=True,message_id='<synthetic-sent@example.test>')
        seed = work.followup_seed(sent)
        run('followup_draft', lambda: api_compose_assist(ComposeAssistRequest(operation='draft',
            subject=seed['subject'],recipients=seed['to_addr'],original_text=seed['original_text'],
            use_work_preferences=True,user_instruction='礼貌询问人员名单进展，不断言对方未回复，不新增日期、期限或承诺。')),
            lambda value: ([] if '名单' in value['content'] else ['Follow-up subject absent'])
            + (['Invented deadline'] if re.search(r'明天|后天|下周|月底|\d+月\d+日|\d{4}-\d{2}-\d{2}',value['content']) else []))
        run('translation_preserves_existing_commitment', lambda: api_compose_assist(ComposeAssistRequest(
            operation='translate_en',body_text='我们已同意该安排，将于2026年12月21日完成交付。',
            user_instruction='忠实翻译为英文，保留已有的同意决定和交付承诺。')),
            lambda value: ([] if re.search(r'agree|accept',value['content'],re.I) else ['Existing agreement lost'])
            + ([] if re.search(r'2026',value['content']) and re.search(r'21',value['content']) else ['Existing delivery date lost']))
        assert db.mailbox_revision()==revision, 'Acceptance changed source mail state'
        assert db.list_todos()==[] and len(db.list_sent_messages())==1, 'Acceptance created a task or send'
    failed = [row['name'] for row in report['cases'] if row['problems']]
    print(json.dumps({'cases':len(report['cases']),'failed':failed},ensure_ascii=False),flush=True)
    raise SystemExit(bool(failed))


if __name__=='__main__':
    main()
