"""Bounded, local-only attachment previews. Never execute embedded content."""
import base64
import io
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 150000


def preview_attachment(att, page=0):
    if len(att['payload']) > MAX_BYTES:
        return {'name': att.get('name') or '附件', 'size': len(att['payload']),
                'kind': 'unsupported', 'message': '文件超过 20 MB，请下载后查看'}
    from .preview_worker import preview_isolated
    return preview_isolated(att, page)


def _preview_attachment(att, page=0):
    payload = att['payload']
    name = att.get('name') or '附件'
    result = {'name': name, 'size': len(payload), 'kind': 'unsupported'}
    if len(payload) > MAX_BYTES:
        return {**result, 'message': '文件超过 20 MB，请下载后查看'}
    suffix = Path(name).suffix.lower()
    try:
        if suffix in {'.xlsx', '.xls'}:
            from .spreadsheet_preview import preview_workbook
            return {**result, **preview_workbook(payload, suffix)}
        if suffix in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}:
            from PIL import Image
            with Image.open(io.BytesIO(payload)) as source:
                if source.width * source.height > 25000000:
                    return {**result, 'message': '图片尺寸过大，请下载后查看'}
                source.thumbnail((2400, 2400))
                output = io.BytesIO()
                source.convert('RGBA').save(output, format='PNG')
            return {**result, 'kind': 'image', 'data': base64.b64encode(output.getvalue()).decode()}
        if suffix == '.pdf':
            from .document_preview import pdf_preview
            return {**result, **pdf_preview(payload, page)}
        if suffix in {'.doc', '.docx'}:
            from .document_preview import word_preview
            return {**result, **word_preview(payload, suffix)}
        if suffix in {'.txt', '.csv', '.md', '.log', '.json', '.xml'}:
            text = None
            for encoding in ('utf-8-sig', 'utf-16', 'gb18030'):
                try:
                    text = payload.decode(encoding)
                    break
                except UnicodeError:
                    continue
            text = text if text is not None else payload.decode('utf-8', errors='replace')
            return {**result, 'kind': 'text', 'text': text[:MAX_TEXT],
                    'message': '内容较长，仅展示前 150000 字符' if len(text) > MAX_TEXT else ''}
    except Exception:
        return {**result, 'message': '此文件无法预览，可能已损坏或格式不受支持，请下载后查看'}
    return {**result, 'message': '暂不支持此格式的在线预览，请下载后查看'}
