"""Manual local analysis preserves identity, manual decisions and failure state."""
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, parser, pipeline, mail_analysis
from test_mail_import import fixture, message, raises


def main():
    with fixture() as (root, account), account('work'):
        email = parser.parse_message(42, message('manual-analysis'), save_raw=True)
        email.update(status='inbox', verdict='unreviewed', review_source='manual_download',
                     is_read=0, is_starred=1, is_local_archive=1, feedback='fp', reviewed=1)
        eid = db.upsert_email(email)
        before = db.get_email(eid)
        scan = dict(score=0, verdict='clean', findings=[], spam_score=0, spam_findings=[], auth={})
        with patch.object(pipeline, '_analyze_url_chains', return_value=([], [])), \
             patch.object(pipeline, '_analyze_attachments', return_value=([], [])), \
             patch.object(mail_analysis.rules, 'scan', return_value=scan), \
             patch.object(pipeline.llm_client, 'available', return_value=False):
            stages = []
            result = mail_analysis.analyze(eid, stages.append)
            assert stages == ['rules', 'attachments', 'saving'], stages
            assert result['state'] == 'complete' and not result['work_analysis']
            after = db.get_email(eid)
            assert after['verdict'] == 'clean' and after['review_source'] == 'rule'
            for field in ('uid', 'folder', 'status', 'is_read', 'is_starred', 'is_local_archive', 'feedback', 'reviewed', 'raw_path'):
                assert before[field] == after[field], field
            # Failure must preserve the previous complete result.
            with patch.object(mail_analysis.rules, 'scan', side_effect=RuntimeError('fixture failure')):
                try: mail_analysis.analyze(eid)
                except RuntimeError: pass
                else: raise AssertionError('Failure was swallowed')
            assert db.get_email(eid)['verdict'] == 'clean'
            # Coalesce double clicks and pin a detached task to its account.
            tasks = []
            with patch.object(mail_analysis, 'start_account_thread', side_effect=lambda work, **kw: tasks.append(work)):
                assert mail_analysis.start(eid)['state'] == 'running'
                assert mail_analysis.start(eid)['state'] == 'running'
                assert len(tasks) == 1
                with account('personal'):
                    assert mail_analysis.status(eid)['state'] == 'idle'
                    raises(mail_analysis.start, eid)
                tasks[0]()
            assert mail_analysis.status(eid)['state'] == 'complete'
            Path(before['raw_path']).unlink()
            raises(mail_analysis.analyze, eid)
    print('PASS manual analysis: atomic failure, local identity/flags/manual feedback, double clicks, account isolation, missing source')


if __name__ == '__main__': main()
