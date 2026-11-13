"""Disposable, bounded document text extraction for local search and comparison."""

import hashlib
from pathlib import Path
from . import db, parser


def _worker(output, attachment, _page):
    try:
        from .assistant_attachments import kind, _pdf, _office, _legacy_xls, MAX_TEXT
        from .security.attachments import analyze_attachment

        raw = attachment["payload"]
        name = attachment["name"]
        ext = kind(name)
        if ext == "pdf":
            text, note = _pdf(raw)
        elif ext in ("docx", "xlsx", "pptx"):
            text, note = _office(raw, ext)
        elif ext == "xls":
            if analyze_attachment(name, attachment.get("content_type") or "", raw).get(
                "has_macro"
            ):
                raise ValueError("不索引含宏的旧版 XLS，请另存为无宏 XLSX")
            text, note = _legacy_xls(raw)
        elif ext in ("txt", "csv", "md"):
            text = None
            for encoding in (
                "utf-8-sig",
                "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8",
                "gb18030",
            ):
                try:
                    text = raw.decode(encoding)
                    break
                except UnicodeError:
                    continue
            if text is None or "\x00" in text:
                raise ValueError("不支持的文本编码，请转换为 UTF-8")
            note = "本地文字提取，不执行 CSV 公式"
        else:
            raise ValueError("该格式暂不建立文字索引，可继续使用附件预览")
        if not text.strip():
            raise ValueError("没有提取到文字，扫描件可使用图片分析")
        output.send(
            {
                "kind": "text",
                "name": name,
                "text": text[:MAX_TEXT],
                "note": note
                + ("；仅提取前 16000 字符" if len(text) > MAX_TEXT else ""),
                "digest": hashlib.sha256(raw).hexdigest(),
            }
        )
    except Exception as exc:
        output.send(
            {
                "kind": "unsupported",
                "message": str(exc)
                if isinstance(exc, ValueError)
                else "附件解析失败，请检查格式或加密状态",
            }
        )
    finally:
        output.close()


def extract_local(email_id, index, *, cache=False):
    from .preview_worker import preview_isolated

    row = db.get_email(email_id)
    if (
        not row
        or row.get("remote_missing")
        or row.get("status") in ("trash", "spam", "quarantine")
    ):
        raise ValueError("请先恢复或核对来源邮件")
    path = Path(row.get("raw_path") or "")
    if not path.is_file() or path.stat().st_size > 40 * 1024 * 1024:
        raise ValueError("本地原始邮件未就绪或超过 40 MB，请单独处理文件")
    attachment = parser.extract_attachment(str(path), index)
    if (
        not attachment
        or not attachment.get("payload")
        or len(attachment["payload"]) > 10 * 1024 * 1024
    ):
        raise ValueError("附件不存在、为空或超过 10 MB")
    digest = hashlib.sha256(attachment['payload']).hexdigest()
    if cache:
        with db.conn() as c:
            cached = c.execute(
                'SELECT digest,name,body,note FROM attachment_text_index WHERE email_id=? AND attachment_index=?',
                (email_id, index),
            ).fetchone()
        if cached and cached['digest'] == digest and cached['name'] == attachment['name']:
            return dict(kind='text', digest=digest, name=cached['name'],
                        text=cached['body'], note=cached['note'])
    result = preview_isolated(attachment, worker=_worker)
    if result.get("kind") != "text":
        raise ValueError(result.get("message") or "文字提取未完成，请稍后重试")
    if cache:
        save_cache(email_id, index, result['digest'], result['name'], result['text'], result['note'])
    return result


def save_cache(email_id: int, index: int, digest: str, name: str, body: str, note: str, connection=None):
    """Persist verified extracted attachment text and invalidate stale semantic attachment chunks."""
    def _write(c):
        c.execute(
            'INSERT OR REPLACE INTO attachment_text_index VALUES(?,?,?,?,?,?)',
            (email_id, index, digest, name, body, note),
        )
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='semantic_chunks'").fetchone():
            base = int(index) * 100
            c.execute(
                "DELETE FROM semantic_chunks WHERE email_id=? AND chunk_kind='attachment' AND chunk_index>=? AND chunk_index<?",
                (email_id, base, base + 100),
            )

    if connection is not None:
        _write(connection)
        return
    with db.conn() as c:
        _write(c)


def warm_email_attachments(email_id: int, *, max_files: int = 4) -> int:
    """Best-effort extract and cache supported document attachments for local search/semantic indexing."""
    from . import assistant_attachments

    row = db.get_email(email_id)
    if (
        not row
        or row.get("remote_missing")
        or row.get("status") in ("trash", "spam", "quarantine")
    ):
        return 0
    raw_path = Path(row.get("raw_path") or "")
    if not raw_path.is_file() or raw_path.stat().st_size > 40 * 1024 * 1024:
        return 0
    try:
        catalog = assistant_attachments.catalog(email_id)
    except ValueError:
        return 0
    with db.conn() as c:
        existing = {
            int(r["attachment_index"]): (r["digest"], r["name"])
            for r in c.execute(
                "SELECT attachment_index, digest, name FROM attachment_text_index WHERE email_id=?",
                (email_id,),
            ).fetchall()
        }
    warmed = 0
    for item in catalog.get("items") or []:
        if warmed >= max_files:
            break
        if not item.get("supported"):
            continue
        ext = assistant_attachments.kind(item.get("name") or "")
        if ext in ("png", "jpg", "jpeg", "webp"):
            continue
        idx = int(item["index"])
        if idx in existing and existing[idx][1] == item.get("name"):
            continue
        try:
            extract_local(email_id, idx, cache=True)
            warmed += 1
        except ValueError:
            continue
    return warmed


def search_excerpts(text, query):
    """Return bounded literal matches without interpreting regex or rendering HTML."""
    import re
    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise ValueError('请填写 1 到 200 个字符的关键词')
    matches = []
    for match in re.finditer(re.escape(query.strip()), text, flags=re.IGNORECASE):
        if len(matches) == 8:
            return {'excerpts':matches, 'more':True, 'empty':not text.strip()}
        matches.append(text[max(0,match.start()-60):min(len(text),match.end()+100)])
    return {'excerpts':matches, 'more':False, 'empty':not text.strip()}


def limited_text(item):
    """Conservatively disclose bounded extraction, never certify whole documents."""
    import re

    note = item.get('note') or ''
    if Path(item.get('name') or '').suffix.lower() in ('.xls', '.xlsx'):
        # Sheet row/cell limits cannot be inferred from the extracted text.
        return True
    if any(int(read) < int(total) for read, total in re.findall(r'(\d+)/(\d+)', note)):
        return True
    return bool(re.search(r'仅提取|截断|内容较长|仅提供', note))
