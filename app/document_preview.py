"""Local document rendering with no Office installation or remote file service."""
import base64
import html
import io
import re
import struct
import threading
import zipfile

_PDF_LOCK = threading.Lock()  # PDFium must not run concurrently on ASGI workers.
LIMIT = 20 * 1024 * 1024


def legacy_doc_text(payload):
    """Word 97–2003 MS-DOC piece table (FibRgFcLcb97.fcClx / PlcPcd)."""
    import olefile
    with olefile.OleFileIO(io.BytesIO(payload)) as ole:
        word = ole.openstream('WordDocument').read(LIMIT + 1)
        if len(word) > LIMIT or len(word) < 426 or word[:2] != b'\xec\xa5':
            raise ValueError('Unsupported Word format')
        flags = struct.unpack_from('<H', word, 10)[0]
        if flags & 0x8100:
            raise ValueError('Encrypted Word file')
        table = ole.openstream('1Table' if flags & 0x200 else '0Table').read(LIMIT + 1)
        if len(table) > LIMIT:
            raise ValueError('Large table stream')
        start, length = struct.unpack_from('<II', word, 0x1a2)
        clx = table[start:start + length]
        pos = 0
        while pos < len(clx) and clx[pos] == 1:
            pos += 3 + struct.unpack_from('<H', clx, pos + 1)[0]
        if pos + 5 > len(clx) or clx[pos] != 2:
            raise ValueError('Missing piece table')
        size = struct.unpack_from('<I', clx, pos + 1)[0]
        pieces = clx[pos + 5:pos + 5 + size]
        if len(pieces) != size or size < 4 or (size - 4) % 12:
            raise ValueError('Invalid piece table')
        count = (size - 4) // 12
        main_chars = min(struct.unpack_from('<I', word, 0x4c)[0], 150000)
        parts = []
        for i in range(count):
            first, last = struct.unpack_from('<II', pieces, i * 4)
            if first >= main_chars:
                break
            if last < first:
                raise ValueError('Invalid character range')
            chars = min(last, main_chars) - first
            fc = struct.unpack_from('<I', pieces, (count + 1) * 4 + i * 8 + 2)[0]
            compressed = bool(fc & 0x40000000)
            offset = (fc & 0x3fffffff) // (2 if compressed else 1)
            amount = chars * (1 if compressed else 2)
            if offset + amount > len(word):
                raise ValueError('Invalid text offset')
            parts.append(word[offset:offset + amount].decode('cp1252' if compressed else 'utf-16le', errors='replace'))
        text = ''.join(parts)
        # Drop field instructions, retain their displayed results.
        text = re.sub(r'\x13[^\x13\x14\x15]*\x14', '', text)
        text = re.sub(r'\x13[^\x13\x15]*\x15', '', text)
        text = text.replace('\x15', '').replace('\r', '\n').replace('\x07', '\t')
        return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', text)


def word_preview(payload, suffix):
    if suffix == '.doc':
        text = legacy_doc_text(payload)
        return {'kind': 'document', 'html': ''.join('<p>' + html.escape(p) + '</p>' for p in text.split('\n')),
                'text': text, 'message': 'DOC 正文阅读视图；复杂表格、图片及原始分页请下载查看'}
    import mammoth
    import bleach
    from PIL import Image
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 50 * 1024 * 1024:
            raise ValueError('Expanded document too large')
    image_budget = [0]
    def convert_image(image):
        with image.open() as stream:
            raw = stream.read(LIMIT + 1)
        image_budget[0] += len(raw)
        if image_budget[0] > LIMIT:
            return {'alt': '图片过大，请下载查看'}
        try:
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > 25000000:
                    return {'alt': '图片尺寸过大，请下载查看'}
                source.thumbnail((1600, 1600))
                out = io.BytesIO(); source.convert('RGBA').save(out, format='PNG')
            return {'src': 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()}
        except Exception:
            return {'alt': '此图片请下载查看'}
    converted = mammoth.convert_to_html(io.BytesIO(payload),
        convert_image=mammoth.images.img_element(convert_image), external_file_access=False)
    clean = bleach.clean(converted.value, tags=['p','h1','h2','h3','h4','h5','h6','strong','em','u','s',
        'sup','sub','ul','ol','li','table','thead','tbody','tr','td','th','br','img','blockquote'],
        attributes=lambda tag, name, value: (tag == 'img' and (name == 'alt' or
            (name == 'src' and value.startswith('data:image/png;base64,')))) or
            (tag in ('td','th') and name in ('colspan','rowspan') and value.isdigit() and int(value) <= 100),
        protocols=['data'], strip=True)
    return {'kind':'document', 'html':clean,
            'message':'Word 阅读视图：保留标题、段落、列表、表格与图片；分页及部分格式可能与原文件不同'}


def pdf_preview(payload, page_index=0):
    import pypdfium2 as pdfium
    with _PDF_LOCK:
        document = pdfium.PdfDocument(payload)
        try:
            count = len(document)
            if not 0 <= page_index < count:
                raise ValueError('Invalid PDF page')
            page = document[page_index]
            try:
                width, height = page.get_size()
                if min(width, height) <= 0:
                    raise ValueError('Invalid PDF dimensions')
                bitmap = page.render(scale=min(2, 1800 / max(width, height)))
                try:
                    output = io.BytesIO(); bitmap.to_pil().save(output, format='PNG')
                finally:
                    bitmap.close()
            finally:
                page.close()
            return {'kind':'pdf', 'page':page_index, 'page_count':count,
                    'data':base64.b64encode(output.getvalue()).decode(),
                    'message':'原版页面预览 · 支持翻页与缩放'}
        finally:
            document.close()
