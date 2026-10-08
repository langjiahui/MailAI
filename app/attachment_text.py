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


def extract_local(email_id, index):
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
    result = preview_isolated(attachment, worker=_worker)
    if result.get("kind") != "text":
        raise ValueError(result.get("message") or "文字提取未完成，请稍后重试")
    return result


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
