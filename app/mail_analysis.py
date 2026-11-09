"""Explicit analysis of an existing local message, pinned to its account."""
import json
import threading
from pathlib import Path

from . import config, db, parser, pipeline, threads
from .account_guard import start_account_thread
from .security import policy, rules, thread_guard

_tasks = {}
_lock = threading.Lock()


def status(email_id):
    with _lock:
        task = _tasks.get(config.DB_PATH, {})
        return dict(task) if task.get('email_id') == email_id else {'email_id': email_id, 'state': 'idle'}


def analyze(email_id):
    row = db.get_email(email_id)
    if not row:
        raise ValueError('邮件不存在，请刷新后重试')
    path = Path(row.get('raw_path') or '')
    if not path.is_file():
        raise ValueError('本地邮件原件不可用，请先补下载邮件')
    original_stat = path.stat()
    if original_stat.st_size > 50 * 1024 * 1024:
        raise ValueError('邮件原件超过单封分析的 50 MB 上限')
    email = parser.parse_message(row['uid'], path.read_bytes(), save_raw=False, folder=row['folder'])
    email['raw_path'] = str(path)
    scan = rules.scan(email)
    url_findings, url_chain = pipeline._analyze_url_chains(email)
    att_findings, att_analysis = pipeline._analyze_attachments(email)
    history = db.list_thread_emails(email.get('thread_id'), limit=8) if email.get('thread_id') else []
    scan['findings'].extend(url_findings + att_findings + thread_guard.detect(email, history))
    scan['findings'] = policy.apply_allowlist(policy.apply(scan['findings']), scan.get('allowlist'))
    scan['spam_findings'] = [] if scan.get('allowlist') else policy.apply(scan['spam_findings'])
    score = min(100, sum(item['weight'] for item in scan['findings']))
    scan['score'] = score
    limits = policy.thresholds()
    verdict = 'phishing' if score >= limits['quarantine_score'] else 'suspicious' if score >= limits['review_score'] else 'clean'
    scan['verdict'] = verdict
    review, analysis = None, None
    if pipeline.llm_client.available():
        if score >= config.LLM_REVIEW_SCORE:
            review = pipeline.llm_analyze.security_review(email, pipeline._rule_summary(scan), threads.get_thread_summary(email.get('thread_id')))
        analysis = pipeline.llm_analyze.work_analysis(email)
    if review:
        if review['phishing'] and review['confidence'] >= .6:
            verdict = 'phishing'
        elif not review['phishing'] and review['confidence'] >= .8 and verdict == 'suspicious':
            verdict = 'clean'
    # Commit results only. The original message, flags, location and manual
    # feedback belong to the user and must survive concurrent analysis.
    fields = dict(score=score, verdict=verdict, findings=json.dumps(scan['findings'] + scan['spam_findings']),
                  auth=json.dumps(scan['auth']), spam_score=scan['spam_score'],
                  url_chain=json.dumps(url_chain), attachment_analysis=json.dumps(att_analysis),
                  review_source='llm' if review else 'rule', llm_phishing=int(review['phishing']) if review else None,
                  llm_reasons=json.dumps(review['reasons'] + review['evidence'] if review else []))
    if analysis:
        fields.update(category=analysis['category'], priority=analysis['priority'], summary=analysis['summary'])
    current_stat = path.stat()
    if (current_stat.st_size, current_stat.st_mtime_ns) != (original_stat.st_size, original_stat.st_mtime_ns):
        raise ValueError('邮件已变化，请刷新后重新分析')
    with db.conn() as c:
        cursor = c.execute('UPDATE emails SET ' + ','.join(name + '=?' for name in fields) +
                           ' WHERE id=? AND raw_path=? AND message_id IS ?', [*fields.values(), email_id, row['raw_path'], row.get('message_id')])
        if not cursor.rowcount:
            raise ValueError('邮件已变化，请刷新后重新分析')
    db.add_audit_log(email_id, 'manual_analysis', actor='user', reason='分析本地原件',
                     meta={'verdict': verdict, 'score': score})
    return {'email_id': email_id, 'state': 'complete', 'work_analysis': bool(analysis)}


def start(email_id):
    if not db.get_email(email_id):
        raise ValueError('邮件不存在，请刷新后重试')
    key = config.DB_PATH
    with _lock:
        task = _tasks.get(key, {})
        if task.get('state') == 'running':
            if task['email_id'] == email_id:
                return dict(task)
            raise ValueError('此邮箱正在分析其他邮件，请稍后重试')
        _tasks[key] = {'email_id': email_id, 'state': 'running'}

    def work():
        try:
            result = analyze(email_id)
        except Exception as exc:
            result = {'email_id': email_id, 'state': 'failed', 'error': str(exc)}
        with _lock:
            _tasks[key] = result
    try:
        start_account_thread(work, name='mail-analysis')
    except Exception:
        with _lock:
            _tasks.pop(key, None)
        raise
    return {'email_id': email_id, 'state': 'running'}
