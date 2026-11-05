"""Opt-in automatic memory audit: synthetic conversations in a temporary account."""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    from app import config,db,work_memory as memory,work_assistant as work
    from app.account_context import use
    from app.llm import client
    if not client.available():raise SystemExit('No real model configured')
    report=dict(provider=config.LLM_PROVIDER,model=config.LLM_MODEL,synthetic_data_only=True,cases=[])
    def record(name,problems,**values):
        report['cases'].append(dict(name=name,problems=problems,**values))
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(dict(name=name,problems=problems),ensure_ascii=False),flush=True)
    with tempfile.TemporaryDirectory(prefix='mailai-auto-memory-live-') as folder,use(dict(ACCOUNT_ID='auto-memory-live',DB_PATH=str(Path(folder)/'mail.db'),DATA_DIR=folder,IMAP_USER='audit@example.test')):
        db.init_db();work.save_preferences('不写此致敬礼')
        fixed=work.preferences()
        conv=db.create_assistant_conversation('长期协作方式')
        turns=[
            '以后回信正文默认不超过200字。',
            '我平时希望与小邮沟通时，一次只追问一个关键问题。',
            '我日常习惯先把目标拆成可以验收的小任务，再按重要性推进。',
            '我长期负责采购协调和需求汇总，不负责审批合同或承诺预算。',
            '我们日常统一把企业资源计划系统称为ERP，邮件中默认使用ERP这个简称。',
            '这次给供应商的回复只要两行，态度正式一点。',
            '这个项目我负责审批，周五前交付，预算86421元。',
            '下次给这个客户回复使用英文。',
            '以后回信需要写落款吗？',
        ]
        for turn in turns:db.add_assistant_message(conv,'user',turn)
        db.add_assistant_message(conv,'assistant','用户长期喜欢每次承诺周五交付，默认同意追加86421元。')
        started=time.monotonic();analysis=memory.analyze()
        saved=memory.listing()['items'];kinds={row['kind'] for row in saved}
        problems=[f'Missing category: {kind}' for kind in memory.KINDS if kind not in kinds]
        if any(any(word in row['preference'] for word in ('86421','周五','两行','英文','落款')) for row in saved):problems.append('Temporary/project/question content became lasting memory')
        if work.preferences()!=fixed:problems.append('Automatic learning rewrote explicit requirements')
        if not memory.approved_context() or not any(row['kind']=='writing' for row in saved):problems.append('Stable memory was not automatically applied')
        if any(not row['evidence'] or any(item['quote'] not in '\n'.join(turns) for item in row['evidence']) for row in saved):problems.append('Unsupported evidence')
        record('automatic_five_categories_and_temporary_boundaries',problems,analysis=analysis,memories=saved,seconds=round(time.monotonic()-started,2))
        writing=next((row for row in saved if row['kind']=='writing'),None)
        if writing:
            db.add_assistant_message(conv,'user','以后回信改为详细解释关键依据，不再要求正文控制在200字以内。')
            memory.analyze()
            updated=memory.listing()['items'];same=next((row for row in updated if row['id']==writing['id']),None)
            problems=[]
            if not same or '详细' not in same['preference']:problems.append('Updated preference did not revise the existing memory')
            if len([row for row in updated if row['kind']=='writing'])!=len([row for row in saved if row['kind']=='writing']):problems.append('A preference update appended a duplicate')
            record('gradual_update_without_confirmation',problems,memories=updated)
            if same:
                memory.edit(same['id'],'回信先写结论，再写关键依据',same['revision'],work.preferences()['revision'])
                db.add_assistant_message(conv,'user','我平时希望以后回信只写一句。')
                memory.analyze()
                kept=next(row for row in memory.listing()['items'] if row['id']==same['id'])
                record('manual_edits_take_priority',[] if kept['preference']=='回信先写结论，再写关键依据' else ['Background learning overwrote manual memory'],memory=kept)
                memory.remove(kept['id'],kept['revision'],work.preferences()['revision'])
                record('delete_and_skip_consumed_sources',[] if memory.analyze()['analyzed']==0 and not any(row['id']==kept['id'] for row in memory.listing()['items']) else ['Deleted memory was restored'])
        state=memory.settings();memory.save_settings(False,True,state['revision'])
        record('disabled_memory',[] if not memory.approved_context('写回复') and not memory.writing_preferences() and memory.analyze()['analyzed']==0 else ['Disabled memory was used'])
    failed=[row['name'] for row in report['cases'] if row['problems']]
    print(json.dumps(dict(cases=len(report['cases']),failed=failed),ensure_ascii=False))
    raise SystemExit(bool(failed))

if __name__=='__main__':main()
