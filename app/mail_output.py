"""Local, inert single-message documents shared by printing and file export.

Only mail content is selected here. Analysis, contact overrides, notes and the
application UI never enter an output document. No resource fetches are made.
"""
from __future__ import annotations

import base64
from datetime import datetime
from email.utils import parsedate_to_datetime
from html import escape
import io
import hashlib
import hmac
from pathlib import Path
import re
import secrets

import bleach
from bleach.css_sanitizer import CSSSanitizer
from lxml import etree, html
from PIL import Image

from . import db, parser
from .mail_headers import decode_header_text

MAX_IMAGE = 3 * 1024 * 1024
MAX_IMAGES = 12 * 1024 * 1024
MAX_DOCUMENT = 24 * 1024 * 1024
_REVISION_KEY = secrets.token_bytes(32)
CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"
CSS = """@page{size:A4;margin:16mm}
*{box-sizing:border-box}html{color-scheme:light;background:white;color:#202824}
body{margin:0;padding:24px;font:14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;overflow-wrap:anywhere}
h1{font-size:22px;line-height:1.4;margin:0 0 16px;overflow-wrap:anywhere}
.mail-output-header{border-bottom:1px solid #ccd4ce;padding-bottom:16px;margin-bottom:20px}
.mail-output-header p{margin:4px 0}.mail-output-header b{display:inline-block;min-width:5em}
.mail-output-body{max-width:100%;overflow-wrap:anywhere}
.mail-output-body *{max-width:100%!important;min-width:0!important;max-height:none!important;overflow:visible!important}
.mail-output-body table{width:100%!important;table-layout:fixed!important;border-collapse:collapse}
.mail-output-body td,.mail-output-body th{overflow-wrap:anywhere!important;word-break:normal!important;white-space:normal!important}
.mail-output-body img{max-width:100%!important;height:auto!important;break-inside:avoid}
.mail-output-body pre{white-space:pre-wrap!important;overflow-wrap:anywhere}
blockquote{margin:12px 0;padding-left:12px;border-left:2px solid #bbc8c0}
a{color:#246044}.mail-output-attachments{margin-top:24px;font-size:12px}
.mail-output-note{font-size:12px;color:#66736c}li{overflow-wrap:anywhere}
@media print{body{padding:0}h1,h2,h3,thead{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}}
"""


def filename(subject: str, suffix: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '_', str(subject or '')).strip(' .')
    value = value.encode('utf-8')[:150].decode('utf-8', errors='ignore') or 'mail'
    if re.fullmatch(r'(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])', value.split('.')[0]):
        value = '_' + value
    return value + suffix


def message(email_id: int, source: str = 'email') -> dict:
    if source not in {'email','sent'}:
        raise ValueError('不支持的导出格式。')
    row = db.get_sent_message(int(email_id)) if source == 'sent' else db.get_email(int(email_id))
    if not row:
        raise ValueError('邮件不存在')
    if source == 'sent':
        row['date'] = row.get('sent_at') or row.get('created_at') or ''
        row['body_text'] = parser.strip_html(row.get('body_html') or '')
    return row


def original(email_id: int, source: str = 'email') -> tuple[Path, str]:
    row = message(email_id, source)
    path = Path(row.get('raw_path') or '')
    if not row.get('raw_path') or not path.is_file():
        raise FileNotFoundError('原始邮件文件不存在，无法导出 EML；仍可打印或复制已缓存的正文。')
    return path, filename(row.get('subject'), '.eml')


def original_revision(path: Path) -> str:
    stat = path.stat()
    identity = repr((str(path),stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns))
    return hmac.new(_REVISION_KEY,identity.encode('utf-8'),hashlib.sha256).hexdigest()


def _raster(payload: bytes, content_type: str) -> str:
    if content_type.lower() not in {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'} or len(payload) > MAX_IMAGE:
        return ''
    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.width * image.height > 24_000_000:
                return ''
            image.verify()
    except (OSError, ValueError, Image.DecompressionBombError):
        return ''
    return f'data:{content_type.lower()};base64,' + base64.b64encode(payload).decode('ascii')


def _body(source: str, row: dict) -> tuple[str, int]:
    try:
        doc = html.fragment_fromstring(source, create_parent='div')
    except (etree.ParserError, AssertionError):
        return '<pre>' + escape(parser.strip_html(source)) + '</pre>', 0
    for node in doc.xpath('.//script|.//style|.//head|.//iframe|.//object|.//embed|.//svg|.//math|.//form|.//template'):
        node.drop_tree()
    # Parse MIME once: several logo references must not reread all attachments.
    inline = []
    path = row.get('raw_path') or ''
    if path and Path(path).is_file():
        try:
            inline = [part for part in parser._reading_message(path).walk() if part.get('Content-ID')]
        except (OSError, ValueError):
            pass
    cids = {str(p.get('Content-ID')).strip().strip('<>').lower(): p for p in inline}
    omitted, total, images = 0, 0, {}
    for node in doc.xpath('.//img'):
        src = node.get('src', '').strip()
        result = images.get(src, '')
        if src not in images:
            part = None
            match = re.fullmatch(r'/api/emails/' + str(row['id']) + r'/inline/([0-9]{1,9})(?:\?mailai_account=[\w-]+)?', src)
            if match and int(match[1]) < len(inline):
                part = inline[int(match[1])]
            elif src.lower().startswith('cid:'):
                part = cids.get(parser._normalize_cid(src[4:]))
            if part is not None:
                payload = part.get_payload(decode=True) or b''
                if total + len(payload) <= MAX_IMAGES:
                    result = _raster(payload, part.get_content_type())
            elif src.startswith('data:image/') and len(src) <= MAX_IMAGE * 4 // 3 + 100:
                try:
                    header, encoded = src.split(',', 1)
                    payload = base64.b64decode(encoded, validate=True)
                    if header.endswith(';base64') and total + len(payload) <= MAX_IMAGES:
                        result = _raster(payload, header[5:-7])
                except (ValueError, TypeError):
                    pass
            images[src] = result
        # Count repeated references as well: each is serialized into the document.
        image_size = (len(result) - result.index(',') - 1) * 3 // 4 if result else 0
        if result and total + image_size <= MAX_IMAGES:
            node.set('src', result)
            total += image_size
        else:
            omitted += 1
            # Retain the alternate text in place of unavailable/remote images.
            node.tag = 'span'
            node.text = node.get('alt') or ''
            node.attrib.clear()
    cleaner = bleach.Cleaner(
        tags={'a','abbr','b','blockquote','br','caption','center','code','col','colgroup','dd','del','details','div','dl','dt','em','font','h1','h2','h3','h4','h5','h6','hr','i','img','ins','li','ol','p','pre','s','section','small','span','strong','sub','summary','sup','table','tbody','td','tfoot','th','thead','tr','u','ul'},
        attributes={'*':['style','dir','lang'], 'a':['href','title'], 'img':['src','alt','width','height'], 'td':['colspan','rowspan'], 'th':['colspan','rowspan'], 'ol':['start'], 'details':['open']},
        protocols={'http','https','mailto','data'}, strip=True,
        css_sanitizer=CSSSanitizer(allowed_css_properties={'color','background-color','font-family','font-size','font-weight','font-style','text-align','text-decoration','vertical-align','line-height','padding','padding-left','padding-right','padding-top','padding-bottom','margin','margin-left','margin-right','border','border-color','border-width','border-style','border-collapse','list-style-type'}),
    )
    # Details are output in full, regardless of reading-page fold state.
    for node in doc.xpath('.//details'):
        node.set('open', 'open')
    # Do not retain data: hyperlinks (only raster img src may use data:).
    for node in doc.xpath('.//a[@href]'):
        if not re.match(r'^(https?://|mailto:)', node.get('href', ''), re.I):
            node.attrib.pop('href', None)
    return cleaner.clean(html.tostring(doc, encoding='unicode')), omitted


def snapshot(email_id: int, language: str = 'zh-CN', source: str = 'email') -> dict:
    row = message(email_id, source)
    en = language == 'en'
    labels = ('Subject','From','To','Cc','Date','Attachments') if en else ('主题','发件人','收件人','抄送','时间','附件')
    subject = str(row.get('subject') or ('(No subject)' if en else '（无主题）'))
    sender = (str(row.get('from_name') or '') + ' <' + str(row.get('from_addr') or '') + '>').strip() if row.get('from_name') else row.get('from_addr') or ''
    fields = [sender, row.get('to_addr') or '', row.get('cc_addr') or '', row.get('date') or '']
    raw_path = row.get('raw_path') or ''
    has_raw = bool(raw_path and Path(raw_path).is_file())
    revision = ''
    if has_raw:
        try:
            revision = original_revision(Path(raw_path))
        except OSError:
            has_raw = False
    if has_raw:
        try:
            headers = parser._read_raw_headers(raw_path)
            fields = [decode_header_text(headers.get(key)) or fallback for key, fallback in zip(('From','To','Cc','Date'), fields)]
        except (OSError, ValueError):
            pass
    if fields[3]:
        try:
            value = str(fields[3])
            date = datetime.fromisoformat(value.replace('Z','+00:00')) if re.match(r'^\d{4}-\d\d-',value) else parsedate_to_datetime(value)
            fields[3] = date.strftime('%Y-%m-%d %H:%M:%S %z').strip()
        except (ValueError, TypeError, OverflowError):
            pass
    rich = parser.extract_rich_body(raw_path, email_id) if has_raw else ''
    rich = rich or row.get('body_html') or ''
    plain = (parser.extract_plain_body(raw_path) if has_raw else '')
    plain = plain or (parser.strip_html(rich) if has_raw and rich else row.get('body_text') or parser.strip_html(rich))
    if not rich and not plain and not has_raw and row.get('body_text') is None and row.get('body_html') is None:
        raise ValueError('邮件正文尚未下载，请先读取完整邮件。')
    if len(rich.encode('utf-8')) > MAX_DOCUMENT or len(plain.encode('utf-8')) > MAX_DOCUMENT:
        raise ValueError('邮件正文过大，请导出原始邮件。')
    body, omitted = _body(rich, row) if rich else ('<pre>' + escape(plain) + '</pre>', 0)
    attachments = row.get('attachments') or []
    attachment_lines = [str(item.get('name') or item.get('filename') or 'attachment') + f" ({int(item.get('size') or 0):,} B)" for item in attachments if isinstance(item, dict)]
    header = ''.join(f'<p><b>{escape(label)}</b> {escape(str(value))}</p>' for label,value in zip(labels[1:5], fields) if value)
    notes = []
    if omitted:
        notes.append('Remote or unavailable images were omitted; no external images were fetched.' if en else '外部或不可用图片未包含在输出中，未额外联网加载。')
    if not has_raw:
        notes.append('Using the cached body; the original EML is unavailable.' if en else '当前使用已缓存的正文，原始 EML 文件不可用。')
    foot = ('<section class="mail-output-attachments"><b>' + labels[5] + '</b><ul>' + ''.join('<li>'+escape(line)+'</li>' for line in attachment_lines) + '</ul></section>') if attachment_lines else ''
    document = '<!doctype html><html lang="'+('en' if en else 'zh-CN')+'"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+CSP+'"><title>'+escape(subject)+'</title><style>'+CSS+'</style></head><body><header class="mail-output-header"><h1>'+escape(subject)+'</h1>'+header+'</header><main class="mail-output-body">'+body+'</main>'+foot+''.join('<p class="mail-output-note">'+escape(note)+'</p>' for note in notes)+'</body></html>'
    text = labels[0]+': '+subject+'\n'+'\n'.join(label+': '+str(value) for label,value in zip(labels[1:5], fields) if value)+'\n\n'+plain
    if attachment_lines:
        text += '\n\n'+labels[5]+':\n'+'\n'.join(attachment_lines)
    return dict(document=document, text=text, filename=filename(subject, ''), has_raw=has_raw,
                original_revision=revision, notes=notes)
