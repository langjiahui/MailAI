"""Account-scoped, resumable imports of exported EML/MBOX mail. No network I/O."""
from __future__ import annotations

import hashlib
import csv
import json
import logging
import mailbox
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid
from email import policy
from email.parser import BytesParser
from pathlib import Path, PurePosixPath

from . import config, db, parser
from .account_guard import start_account_thread

log = logging.getLogger(__name__)
MAX_SOURCE_SIZE = 1024**3
MAX_MESSAGE_SIZE = 64 * 1024**2
MAX_TOTAL_SIZE = 10 * 1024**3
MAX_FILES = 20_000
MAX_MESSAGES = 200_000
_lock = threading.RLock()
_active = set()


class Paused(Exception):
    pass


class SourceLimit(Exception):
    pass


def _root():
    owner = hashlib.sha256(os.path.realpath(config.DB_PATH).encode()).hexdigest()[:24]
    return Path(config.DATA_DIR) / 'mail-client-imports' / owner


def _path(token):
    if not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('导入记录不存在，请重新选择文件')
    return _root() / token


def _read(token):
    try:
        return json.loads((_path(token) / 'job.json').read_text('utf-8'))
    except FileNotFoundError:
        raise ValueError('此邮箱没有这条导入记录，请重新选择文件') from None


def _write(job):
    path = _path(job['token']) / 'job.json'
    partial = path.with_suffix('.part')
    partial.write_text(json.dumps(job, ensure_ascii=False), 'utf-8')
    os.replace(partial, path)


def _update(token, **fields):
    with _lock:
        job = _read(token)
        job.update(fields, updated_at=time.time())
        _write(job)
        return job


def _public(job):
    return {k: v for k, v in job.items() if k != 'sources'}


def status(token):
    with _lock:
        job = _read(token)
        if job['state'] in ('scanning', 'importing', 'uploading') and str(_path(token)) not in _active:
            job.update(state='paused', error='上次操作已中断。点击继续即可，已导入邮件会保留。')
            if job['phase'] == 'upload':
                job.update(state='collecting', error='上次文件添加未完成，请重新选择文件。')
            _write(job)
        return _public(job)


def history():
    root = _root()
    if not root.exists():
        return []
    paths = sorted(root.glob('*/job.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:10]
    return [status(p.parent.name) for p in paths]


def report(token):
    """Build a bounded-memory, account-scoped CSV from all recorded issues."""
    with _lock:
        job = _read(token)
        if str(_path(token)) in _active:
            raise ValueError('请先等待扫描或导入完成，再下载问题清单')
        target = _path(token) / 'issues.csv'
        partial = target.with_suffix('.part')
        def cell(value):
            text = str(value or '')
            # Exported filenames/subjects are untrusted spreadsheet cells.
            return "'" + text if text.lstrip().startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')) else text
        try:
            with partial.open('w', encoding='utf-8-sig', newline='') as output:
                writer = csv.writer(output)
                writer.writerow(['阶段', '类型', '文件或邮件', '原因', '归档名称'])
                for phase, label in (('scan', '扫描'), ('import', '导入')):
                    path = _path(token) / (phase + '-issues.jsonl')
                    if not path.exists():
                        continue
                    with path.open(encoding='utf-8') as source:
                        for line in source:
                            issue = json.loads(line)
                            writer.writerow([label, '请核对' if issue.get('kind') == 'warning' else '未导入',
                                             cell(issue['file']), cell(issue['reason']), cell(job['label'])])
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
        return str(target)


def _record_issue(stream, preview, file, reason, kind='failed'):
    issue = dict(file=file, reason=reason, kind=kind)
    stream.write(json.dumps(issue, ensure_ascii=False) + '\n')
    stream.flush()
    if len(preview) < 30:
        preview.append(issue)


def create(label='Foxmail 导入', expected_files=0):
    label = str(label).strip()
    if not label or len(label) > 80 or any(ch in label for ch in '/\\\x00'):
        raise ValueError('请输入不超过 80 字的归档名称，不要包含斜杠')
    if not 0 <= expected_files <= MAX_FILES:
        raise ValueError('一批最多添加 20000 个文件，请分批导入')
    with _lock:
        for job in history():
            if job['state'] in ('scanning', 'importing', 'uploading'):
                raise ValueError('此邮箱正在导入，请先等待或暂停当前任务')
        token = uuid.uuid4().hex
        directory = _path(token)
        (directory / 'sources').mkdir(parents=True, mode=0o700)
        (directory / 'messages').mkdir(mode=0o700)
        job = dict(token=token, label=label, state='collecting', phase='upload',
                   created_at=time.time(), updated_at=time.time(), bytes=0,
                   files=0, expected_files=expected_files, processed=0, total=0, found=0, new=0, duplicates=0,
                   imported=0, failed=0, errors=[], samples=[], issue_count=0, folders=[],
                   current_source='', source_processed=0, source_total=0, cancel=False, error='')
        _write(job)
        return _public(job)


def begin_upload(token, name):
    path = PurePosixPath(str(name).replace('\\', '/'))
    if (not str(name) or len(str(name)) > 1024 or path.is_absolute() or
            '..' in path.parts or any(':' in p or '\x00' in p for p in path.parts)):
        raise ValueError('文件路径无效，请选择 Foxmail 导出的邮件文件')
    if path.suffix.lower() not in ('.eml', '.mbox'):
        raise ValueError('请选择邮件文件（.eml 或 .mbox），不能直接导入 Foxmail 数据库')
    with _lock:
        job = _read(token)
        if job['state'] != 'collecting':
            raise ValueError('当前任务不能添加文件，请先完成或重新选择')
        if job['files'] >= MAX_FILES:
            raise ValueError('一批最多添加 20000 个文件，请分批导入')
        key = uuid.uuid4().hex + path.suffix.lower()
        _active.add(str(_path(token)))
        _update(token, state='uploading')
        return key, _path(token) / 'sources' / key, str(path)


def finish_upload(token, key, name, size):
    with _lock:
        job = _read(token)
        if not size:
            raise ValueError('文件为空，请在 Foxmail 中重新导出后再选择')
        if size > MAX_SOURCE_SIZE or job['bytes'] + size > MAX_TOTAL_SIZE:
            raise ValueError('超过大小限制：单个文件 1 GB，每批 10 GB')
        # Store each source separately: progress updates must stay constant-size
        # even for a directory containing thousands of individual EML files.
        meta = _path(token) / 'sources' / f"{job['files']:08d}.json"
        meta.write_text(json.dumps(dict(key=key, name=name, size=size), ensure_ascii=False), 'utf-8')
        job.update(files=job['files'] + 1, bytes=job['bytes'] + size, state='collecting')
        _write(job)
        return _public(job)


def end_upload(token):
    with _lock:
        _active.discard(str(_path(token)))
        if _read(token)['state'] == 'uploading':
            _update(token, state='collecting')


def _check(token):
    with _lock:
        if _read(token)['cancel']:
            raise Paused()


def pause(token):
    with _lock:
        job = _read(token)
        if job['state'] in ('scanning', 'importing'):
            _update(token, cancel=True)
        return status(token)


def discard(token):
    with _lock:
        if str(_path(token)) in _active:
            raise ValueError('请先暂停当前任务，再重新选择文件')
        shutil.rmtree(_path(token), ignore_errors=False)
        return {'ok': True}


def start(token, phase):
    with _lock:
        job = _read(token)
        if str(_path(token)) in _active:
            return _public(job)  # Double clicks never start a second writer.
        if phase == 'scan':
            if job.get('expected_files') and job['files'] != job['expected_files']:
                raise ValueError('文件添加未完成，请重新选择整批文件后再扫描')
            if (job['state'] not in ('collecting', 'paused', 'failed') or not job['files'] or
                    job['phase'] == 'import'):
                raise ValueError('请先选择邮件文件')
        elif phase == 'import':
            if (not (job['state'] == 'ready' or job['state'] in ('paused', 'failed') and job['phase'] == 'import') or
                    not (_path(token) / 'plan.jsonl').exists()):
                raise ValueError('请先扫描文件并查看结果')
        else:
            raise ValueError('导入操作无效')
        _active.add(str(_path(token)))
        _update(token, phase=phase, state='scanning' if phase == 'scan' else 'importing', cancel=False, error='')
        try:
            start_account_thread(lambda: _run(token, phase), name='mailai-client-import')
        except BaseException:
            _active.discard(str(_path(token)))
            _update(token, state='failed', error='无法启动导入任务，请重试')
            raise
        return _public(_read(token))


def _run(token, phase):
    outcome = None
    try:
        outcome = (scan if phase == 'scan' else execute)(token)
    except Paused:
        outcome = dict(state='paused', error='')
    except SourceLimit as exc:
        outcome = dict(state='failed', error=str(exc))
    except Exception:
        log.exception('Client mail import failed')
        outcome = dict(state='failed', error='导入暂时停止。请检查磁盘空间和文件是否可读，再点击继续。')
    finally:
        with _lock:
            _active.discard(str(_path(token)))
            if outcome:
                _update(token, **outcome)


def signature(raw):
    """Ignore transport headers/line endings, but retain identity and all MIME parts.

    A reused Message-ID with changed body/attachments is deliberately not merged.
    """
    if not raw or len(raw) > MAX_MESSAGE_SIZE:
        raise ValueError('单封邮件为空或超过 64 MB，请在 Foxmail 中单独检查')
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    if not msg.keys() or not any(msg.get(k) for k in ('From', 'To', 'Subject', 'Message-ID')):
        raise ValueError('未找到有效邮件内容，请重新从 Foxmail 导出')
    clean = lambda s: unicodedata.normalize('NFC', str(s or '').replace('\r\n', '\n').strip())
    headers = [clean(msg.get(k)) for k in ('Message-ID', 'From', 'To', 'Cc', 'Date', 'Subject')]
    parts = []
    for part in msg.walk():
        if part.is_multipart():
            # A forwarded mail is multipart in Python's model: preserve its
            # attachment identity and each embedded message's own headers too.
            parts.append(['container', part.get_content_type(), clean(part.get_filename()),
                          clean(part.get('Content-ID')), clean(part.get('Content-Disposition')),
                          [clean(part.get(k)) for k in ('Message-ID', 'From', 'To', 'Date', 'Subject')]])
            continue
        payload = part.get_payload(decode=True) or b''
        if (part.get_content_maintype() == 'text' and part.get_content_disposition() != 'attachment'
                and not part.get_filename()):
            # Equivalent exported CRLF/LF text is the same mail; binary attachments
            # remain byte exact, including inline images and forwarded messages.
            payload = parser._decoded_text_part(part).replace('\r\n', '\n').rstrip('\n').encode('utf-8')
        parts.append([part.get_content_type(), clean(part.get_filename()),
                      clean(part.get('Content-ID')), part.get_content_disposition(),
                      [clean(part.get(k)) for k in ('Message-ID', 'From', 'To', 'Date', 'Subject')],
                      hashlib.sha256(payload).hexdigest()])
    digest = hashlib.sha256(json.dumps([headers, parts], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return hashlib.sha256(raw).hexdigest(), digest, clean(msg.get('Message-ID'))


def _table(c):
    c.execute('''CREATE TABLE IF NOT EXISTS mail_client_fingerprints (
        email_id INTEGER PRIMARY KEY, raw_digest TEXT, digest TEXT, raw_path TEXT,
        size INTEGER, mtime INTEGER, batch_token TEXT DEFAULT '')''')
    c.execute('CREATE INDEX IF NOT EXISTS idx_client_digest ON mail_client_fingerprints(digest)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_client_raw_digest ON mail_client_fingerprints(raw_digest)')


def _existing(token):
    with db.conn() as c:
        _table(c)
        rows = c.execute('SELECT id,message_id,raw_path FROM emails WHERE remote_missing=0').fetchall()
        cached = {row['email_id']: dict(row) for row in c.execute('SELECT * FROM mail_client_fingerprints')}
    raw_set, digest_set, unknown_ids = set(), set(), set()
    for i, row in enumerate(rows):
        _check(token)
        path = row['raw_path'] or ''
        try:
            stat = os.stat(path)
            if stat.st_size > MAX_MESSAGE_SIZE:
                raise ValueError('oversized')
            cache = cached.get(row['id'])
            if not cache or (cache['raw_path'], cache['size'], cache['mtime']) != (path, stat.st_size, stat.st_mtime_ns):
                raw_digest, digest, _ = signature(Path(path).read_bytes())
                cache = dict(raw_digest=raw_digest, digest=digest)
                with db.conn() as c:
                    c.execute('''INSERT INTO mail_client_fingerprints(email_id,raw_digest,digest,raw_path,size,mtime)
                        VALUES(?,?,?,?,?,?) ON CONFLICT(email_id) DO UPDATE SET
                        raw_digest=excluded.raw_digest,digest=excluded.digest,raw_path=excluded.raw_path,
                        size=excluded.size,mtime=excluded.mtime''',
                        (row['id'], raw_digest, digest, path, stat.st_size, stat.st_mtime_ns))
            raw_set.add(cache['raw_digest']); digest_set.add(cache['digest'])
        except (OSError, ValueError, UnicodeError):
            if row['message_id']:
                unknown_ids.add(str(row['message_id']).strip())
        if i % 25 == 0:
            _update(token, message=f'正在核对本机已有邮件：{i + 1} / {len(rows)}')
    return raw_set, digest_set, unknown_ids


def _messages(source, directory):
    path = directory / 'sources' / source['key']
    if path.suffix == '.eml':
        with path.open('rb') as stream:
            yield source['name'], stream.read(MAX_MESSAGE_SIZE + 1), 1
    else:
        box = mailbox.mbox(str(path), create=False)
        try:
            if len(box) > MAX_MESSAGES:
                raise ValueError('邮件文件包含超过 200000 封邮件，请在 Foxmail 中分批导出')
            if not len(box):
                raise ValueError('邮件文件中没有找到邮件，请重新导出')
            for i, key in enumerate(box.iterkeys()):
                with box.get_file(key) as stream:
                    yield f"{source['name']} · 第 {i + 1} 封", stream.read(MAX_MESSAGE_SIZE + 1), len(box)
        finally:
            box.close()


def _sources(token, job):
    for i in range(job['files']):
        yield json.loads((_path(token) / 'sources' / f'{i:08d}.json').read_text('utf-8'))


def _parse_exported(raw):
    try:
        return parser.parse_message(0, raw, save_raw=False)
    except (MemoryError, OSError):
        raise
    except Exception as exc:
        # A malformed MIME record must not stop all other exported messages.
        raise ValueError('邮件内容无法解析，请重新导出此邮件') from exc


def scan(token):
    job, directory = _read(token), _path(token)
    _update(token, found=0, new=0, duplicates=0, failed=0, samples=[], errors=[], processed=0,
            folders=[], issue_count=0, current_source='', source_processed=0, source_total=0,
            total=job['files'], message='正在核对已有邮件，随后扫描所选文件')
    raw_set, digest_set, unknown_ids = _existing(token)
    counters = dict(found=0, new=0, duplicates=0, failed=0)
    samples, errors, folder_counts = [], [], {}
    issue_count = 0
    seen_raw, seen_digest = set(), set()
    shutil.rmtree(directory / 'messages', ignore_errors=True)
    (directory / 'messages').mkdir(mode=0o700)
    with (directory / 'plan.jsonl').open('w', encoding='utf-8') as plan, \
            (directory / 'scan-issues.jsonl').open('w', encoding='utf-8') as issues:
        for index, source in enumerate(_sources(token, job)):
            _check(token)
            _update(token, processed=index, current_source=source['name'], source_processed=0,
                    source_total=0, message=f"正在读取文件 {index + 1} / {job['files']}")
            source_processed = source_total = 0
            try:
                for name, raw, source_total in _messages(source, directory):
                    _check(token)
                    counters['found'] += 1
                    source_processed += 1
                    if counters['found'] > MAX_MESSAGES:
                        raise SourceLimit('一批最多导入 200000 封邮件，请点击「重新选择」并分批导入。')
                    try:
                        raw_digest, digest, message_id = signature(raw)
                        duplicate = (raw_digest in raw_set or digest in digest_set or raw_digest in seen_raw or
                                     digest in seen_digest or (message_id and message_id in unknown_ids))
                        if duplicate:
                            counters['duplicates'] += 1
                            if message_id in unknown_ids:
                                issue_count += 1
                                _record_issue(issues, errors, name, '本机已有同标识邮件，但原文不完整，已跳过以免重复', 'warning')
                        else:
                            parsed = _parse_exported(raw)
                            key = f"{counters['new']:08d}.eml"
                            try:
                                (directory / 'messages' / key).write_bytes(raw)
                            except OSError as exc:
                                raise RuntimeError('暂存邮件失败，请检查磁盘空间') from exc
                            folder = str(PurePosixPath(source['name']).parent)
                            if folder == '.':
                                folder = PurePosixPath(source['name']).stem if source['key'].endswith('.mbox') else ''
                            item = dict(key=key, raw_digest=raw_digest, digest=digest, message_id=message_id,
                                        folder=folder, source=name, subject=parsed['subject'], date=parsed['date'], from_addr=parsed['from_addr'])
                            try:
                                plan.write(json.dumps(item, ensure_ascii=False) + '\n')
                            except OSError as exc:
                                raise RuntimeError('暂存邮件清单失败，请检查磁盘空间') from exc
                            seen_raw.add(raw_digest); seen_digest.add(digest)
                            folder_counts[folder] = folder_counts.get(folder, 0) + 1
                            counters['new'] += 1
                            if len(samples) < 20:
                                samples.append({k: str(item[k])[:1024] for k in ('folder', 'subject', 'date', 'from_addr')})
                    except (ValueError, UnicodeError, KeyError, TypeError):
                        counters['failed'] += 1
                        issue_count += 1
                        _record_issue(issues, errors, name, '邮件格式不完整或单封超过 64 MB，请重新导出此邮件')
                    # Duplicates also advance the visible MBOX heartbeat.
                    if source_processed == 1 or source_processed % 25 == 0:
                        _update(token, **counters, errors=errors, issue_count=issue_count,
                                source_processed=source_processed, source_total=source_total,
                                message=f"正在扫描文件 {index + 1} / {job['files']} · 已识别 {counters['found']} 封")
            except (OSError, ValueError) as exc:
                counters['failed'] += 1
                issue_count += 1
                _record_issue(issues, errors, source['name'], str(exc) if isinstance(exc, ValueError) else '文件读取失败，请重新选择')
            _update(token, **counters, samples=samples, errors=errors, issue_count=issue_count,
                    processed=index + 1, source_processed=source_processed, source_total=source_total,
                    message=f"正在扫描文件 {index + 1} / {job['files']} · 已识别 {counters['found']} 封")
    _check(token)
    if not counters['new']:
        shutil.rmtree(directory / 'sources', ignore_errors=True)
        shutil.rmtree(directory / 'messages', ignore_errors=True)
    folders = sorted(folder_counts.items(), key=lambda item: (-item[1], item[0]))
    return dict(state='ready', scan_failed=counters['failed'], scan_duplicates=counters['duplicates'],
                scan_errors=errors, scan_issue_count=issue_count, issue_count=issue_count,
                folders=[dict(name=name, count=count) for name, count in folders[:30]], folder_count=len(folders),
                current_source='', message='扫描完成，请核对结果后开始导入')


def _insert(token, item, raw):
    parsed = _parse_exported(raw)
    job = _read(token)
    folder = 'LOCAL_IMPORT/' + job['label'] + ('/' + item['folder'] if item['folder'] else '')
    directory = Path(config.RAW_DIR) / 'client-import'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / (uuid.uuid4().hex + '.eml')
    # Copy before the transaction; failure cannot leave a row with missing content.
    try:
        target.write_bytes(raw)
        with db.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            duplicate = c.execute('''SELECT f.batch_token FROM mail_client_fingerprints f JOIN emails e ON e.id=f.email_id
                WHERE e.remote_missing=0 AND (f.digest=? OR f.raw_digest=?) LIMIT 1''',
                (item['digest'], item['raw_digest'])).fetchone()
            if duplicate:
                return 'owned' if duplicate['batch_token'] == token else 'duplicate'
            # Sync may have downloaded a matching mail after the preview/index.
            candidates = c.execute('''SELECT e.id,e.raw_path FROM emails e LEFT JOIN mail_client_fingerprints f ON f.email_id=e.id
                WHERE e.remote_missing=0 AND COALESCE(e.message_id,'')=? AND f.email_id IS NULL''', (item['message_id'],)).fetchall()
            for row in candidates:
                try:
                    with open(row['raw_path'] or '', 'rb') as stream:
                        digest = signature(stream.read(MAX_MESSAGE_SIZE + 1))[1]
                    if digest == item['digest']:
                        return 'duplicate'
                except (OSError, ValueError, UnicodeError):
                    if item['message_id']:
                        return 'duplicate'
            uid = c.execute('SELECT MIN(COALESCE((SELECT MIN(uid) FROM emails),0),0)-1').fetchone()[0]
            record = {k: parsed[k] for k in ('message_id','in_reply_to','references_header','thread_id','subject','from_addr','from_name','to_addr','cc_addr','recipient_names','date','snippet','body_text','body_html','urls','attachments')}
            for key in ('recipient_names', 'urls', 'attachments'):
                record[key] = json.dumps(record[key], ensure_ascii=False)
            record.update(uid=uid, folder=folder, status='local_archive', is_local_archive=1,
                          is_read=1, arrival_kind='history', notification_sent=1, processing_complete=1,
                          raw_path=str(target), created_at=time.strftime('%Y-%m-%dT%H:%M:%S'),
                          action_mode='observe', action_reason='从其他邮件客户端导入，仅保存在本机',
                          verdict='unreviewed', review_source='client_import', summary=parsed['snippet'])
            keys = list(record)
            cursor = c.execute(f"INSERT INTO emails({','.join(keys)}) VALUES({','.join('?' for _ in keys)})", [record[k] for k in keys])
            stat = target.stat()
            c.execute('INSERT INTO mail_client_fingerprints VALUES(?,?,?,?,?,?,?)',
                      (cursor.lastrowid, item['raw_digest'], item['digest'], str(target), stat.st_size, stat.st_mtime_ns, token))
        target = None
        return 'imported'
    finally:
        if target is not None:
            target.unlink(missing_ok=True)


def execute(token):
    job = _read(token)
    _existing(token)  # Refresh after preview; another client may have synced mail.
    with db.conn() as c:
        imported = c.execute('''SELECT COUNT(*) FROM mail_client_fingerprints f
            JOIN emails e ON e.id=f.email_id WHERE f.batch_token=?''', (token,)).fetchone()[0]
    duplicates, failed, errors = job.get('scan_duplicates', 0), job.get('scan_failed', 0), job.get('scan_errors', [])[:30]
    issue_count = job.get('scan_issue_count', len(errors))
    _update(token, imported=imported, duplicates=duplicates, failed=failed, errors=errors,
            issue_count=issue_count, processed=0, total=job['new'], current_source='',
            message='正在核对新增邮件，随后逐封保存')
    with (_path(token) / 'plan.jsonl').open(encoding='utf-8') as plan, \
            (_path(token) / 'import-issues.jsonl').open('w', encoding='utf-8') as issues:
        for i, line in enumerate(plan):
            _check(token)
            item = json.loads(line)
            try:
                raw = (_path(token) / 'messages' / item['key']).read_bytes()
                if signature(raw)[:2] != (item['raw_digest'], item['digest']):
                    raise ValueError('文件内容发生变化，请重新选择')
                result = _insert(token, item, raw)
                imported += int(result == 'imported'); duplicates += int(result == 'duplicate')
            except (OSError, ValueError, UnicodeError):
                failed += 1
                issue_count += 1
                _record_issue(issues, errors, item.get('source') or item['subject'], '此邮件未导入，请检查文件和磁盘空间后重试')
            _update(token, imported=imported, duplicates=duplicates, failed=failed, errors=errors,
                    issue_count=issue_count, current_source=item.get('source') or item['subject'], processed=i + 1,
                    message=f"正在导入：{i + 1} / {job['new']} · 已新增 {imported} 封")
    _check(token)
    retry = failed > job.get('scan_failed', 0)
    db.add_audit_log(None, 'client_mail_import', actor='user', reason='导入旧邮件，仅保存在本机',
                     meta={'token': token, 'imported': imported, 'duplicates': duplicates, 'failed': failed})
    # Keep the retry inputs only if some candidates failed to write.
    if failed == job.get('scan_failed', 0):
        shutil.rmtree(_path(token) / 'sources', ignore_errors=True)
        shutil.rmtree(_path(token) / 'messages', ignore_errors=True)
    # Publish the final state only after writes, audit and cleanup have finished.
    # _run releases the active flag and publishes this under the same lock.
    return dict(state='failed' if retry else 'completed',
                current_source='',
                error='部分邮件未能写入。请检查磁盘空间，再点击继续重试；已导入邮件会保留。' if retry else '',
                message='导入完成。旧邮件已保存在此邮箱的「本地归档」中。')
