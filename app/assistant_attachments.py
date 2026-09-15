"""Bounded read-only attachment extraction. No Office execution or external links."""
import base64
import hashlib
import io
import re
import posixpath
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from . import db, parser, assistant_vision
from .security.attachments import analyze_attachment

MAX_FILE = 10 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024
MAX_TEXT = 16000
MAX_COMBINED_TEXT = 30000
MAX_LOCAL_LOOKUP_TEXT = 300000
SUPPORTED = {'png','jpg','jpeg','webp','pdf','docx','xls','xlsx','pptx','txt','csv','md'}


def kind(name):
    return str(name).rsplit('.', 1)[-1].lower()


def catalog(email_id):
    row = db.get_email(email_id)
    if not row or row.get('remote_missing'):
        raise ValueError('邮件不存在或已移除，请重新同步后选择')
    items = []
    for index, item in enumerate(row.get('attachments') or []):
        name = str(item.get('name') or '未命名附件')
        ext = kind(name)
        reason = '' if ext in SUPPORTED else '暂不支持此格式，请转换为 PDF、DOCX、XLS、XLSX、PPTX、文本或截图'
        if (item.get('size') or 0) > MAX_FILE:
            reason = '附件超过 10 MB，请先拆分'
        items.append(dict(index=index, name=name, size=item.get('size') or 0, supported=not reason, reason=reason))
    return dict(email_id=email_id, subject=row.get('subject') or '无主题', items=items)


def _xml(archive, path):
    raw = archive.read(path)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('附件包含不支持的 XML 声明')
    return ET.fromstring(raw)


def _office(raw, ext, *, expanded=False):
    chunks, notes = [], []
    char_count = 0
    char_limit = MAX_LOCAL_LOOKUP_TEXT

    def add(value):
        nonlocal char_count
        value = str(value)
        remaining = char_limit - char_count
        if remaining <= 0:
            return False
        chunks.append(value[:remaining])
        char_count += min(len(value), remaining) + 1
        return len(value) <= remaining

    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        infos = z.infolist()
        if len(infos) > 1200 or sum(i.file_size for i in infos) > 24 * 1024 * 1024 or any(i.file_size > 8*1024*1024 or i.file_size > max(i.compress_size, 1)*200 for i in infos):
            raise ValueError('文档展开后过大，请先拆分')
        if any('vbaproject' in i.filename.lower() for i in infos):
            raise ValueError('暂不分析含宏的附件，请导出为无宏文档或 PDF')
        if ext == 'docx':
            root = _xml(z, 'word/document.xml')
            for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
                if not add(''.join(n.text or '' for n in p.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))):
                    break
            notes.append('提取正文与表格文字；不含图片、批注、页眉页脚或修订语义。')
        elif ext == 'pptx':
            slides = sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n:int(re.search(r'slide(\d+)',n)[1]))
            slide_limit = 80 if expanded else 30
            for number, path in enumerate(slides[:slide_limit], 1):
                root = _xml(z,path)
                if not add(f'幻灯片 {number}\n' + '\n'.join(n.text or '' for n in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'))):
                    break
            notes.append(f'提取前 {min(slide_limit,len(slides))}/{len(slides)} 页文字；不含图片、图表数据、备注和动画。')
        else:
            ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
            strings = []
            if 'xl/sharedStrings.xml' in z.namelist():
                strings = [''.join(n.text or '' for n in item.iter(ns+'t')) for item in _xml(z,'xl/sharedStrings.xml').iter(ns+'si')]
            sheets = [(n,n.rsplit('/',1)[-1]) for n in sorted(z.namelist()) if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)]
            if 'xl/workbook.xml' in z.namelist() and 'xl/_rels/workbook.xml.rels' in z.namelist():
                relations={r.get('Id'):r.get('Target','') for r in _xml(z,'xl/_rels/workbook.xml.rels') if r.get('TargetMode') != 'External'}
                ordered=[]
                for sheet in _xml(z,'xl/workbook.xml').iter(ns+'sheet'):
                    target=relations.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'),'')
                    path=posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/'+target)
                    if path.startswith('xl/worksheets/') and path in z.namelist():
                        ordered.append((path,sheet.get('name') or path))
                if ordered:sheets=ordered
            sheet_limit, row_limit, cell_limit = ((20, 1000, 80) if expanded else (6, 200, 40))
            stopped = False
            for path, title in sheets[:sheet_limit]:
                if not add('工作表：' + title):
                    break
                for row_number, row in enumerate(_xml(z,path).iter(ns+'row')):
                    if row_number >= row_limit:
                        break
                    values = []
                    for cell_number, cell in enumerate(row.iter(ns+'c')):
                        if cell_number >= cell_limit:
                            break
                        text = cell.findtext(ns+'v') or ''
                        if cell.get('t') == 's':
                            text = strings[int(text)] if text.isdigit() and int(text)<len(strings) else '（字符串索引不可读）'
                        elif cell.get('t') == 'inlineStr':
                            text = ''.join(n.text or '' for n in cell.iter(ns+'t'))
                        formula = cell.findtext(ns+'f')
                        if formula:
                            text = f'公式={formula}；缓存值={text or "无"}'
                        values.append(f'{cell.get("r", "单元格")}:{text[:500]}')
                    if not add(' | '.join(values)):
                        stopped = True
                        break
                if stopped:
                    break
            notes.append(f'提取前 {min(sheet_limit,len(sheets))}/{len(sheets)} 个工作表，每表前 {row_limit} 行、每行前 {cell_limit} 个单元格；只读原始值和缓存，不重算公式。日期可能为序列号，不含格式、图表或隐藏状态判断。')
    return '\n'.join(chunks), ' '.join(notes)


def _pdf(raw):
    from pypdf import PdfReader
    from pypdf import filters
    # Bound decompression even when a small PDF contains oversized compressed streams.
    for name in ('ZLIB_MAX_OUTPUT_LENGTH','LZW_MAX_OUTPUT_LENGTH','RUN_LENGTH_MAX_OUTPUT_LENGTH','JBIG2_MAX_OUTPUT_LENGTH'):
        setattr(filters,name,8 * 1024 * 1024)
    reader = PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted:
        raise ValueError('加密 PDF 暂不支持，请提供解密后的副本')
    pages, chunks = len(reader.pages), []
    for i, page in enumerate(reader.pages[:20],1):
        chunks.append(f'第 {i} 页\n' + (page.extract_text() or '')[:MAX_TEXT])
        if sum(map(len,chunks)) > MAX_TEXT:
            break
    text = '\n'.join(chunks)
    if len(re.sub(r'第 \d+ 页|\s','',text)) < 10:
        raise ValueError('此 PDF 未提取到可用文字，可能是扫描件；请上传需要分析的页面截图')
    return text, f'已提取前 {len(chunks)}/{pages} 页文字，最多 20 页；扫描图、表格排版和图表不保证完整，请核对原文件。'


def _legacy_xls(raw, *, expanded=False):
    """Read bounded values from legacy BIFF/OLE workbooks without executing Office or formulas."""
    import xlrd

    sheet_limit, row_limit, cell_limit = ((20, 1000, 80) if expanded else (6, 200, 40))
    chunks = []
    char_count = 0

    def add(value):
        nonlocal char_count
        value = str(value)
        remaining = MAX_LOCAL_LOOKUP_TEXT - char_count
        if remaining <= 0:
            return False
        chunks.append(value[:remaining])
        char_count += min(len(value), remaining) + 1
        return len(value) <= remaining

    book = xlrd.open_workbook(file_contents=raw, on_demand=True)
    try:
        total_sheets = int(book.nsheets)
        stopped = False
        for index in range(min(total_sheets, sheet_limit)):
            sheet = book.sheet_by_index(index)
            if not add('工作表：' + str(sheet.name)):
                break
            for row_number in range(min(int(sheet.nrows), row_limit)):
                values = []
                for column_number in range(min(int(sheet.ncols), cell_limit)):
                    cell = sheet.cell(row_number, column_number)
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        try:
                            value = xlrd.xldate_as_datetime(value, book.datemode).isoformat(sep=' ')
                        except (ValueError, OverflowError):
                            value = str(value)
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = 'TRUE' if value else 'FALSE'
                    elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        value = ''
                    values.append(f'R{row_number + 1}C{column_number + 1}:{str(value)[:500]}')
                if not add(' | '.join(values)):
                    stopped = True
                    break
            if stopped:
                break
    finally:
        book.release_resources()
    note = (
        f'旧版 XLS 只读提取前 {min(sheet_limit, total_sheets)}/{total_sheets} 个工作表，'
        f'每表前 {row_limit} 行、每行前 {cell_limit} 个单元格；公式仅显示文件中已保存的结果，'
        '不执行宏，不含格式、图表或隐藏状态判断。'
    )
    return '\n'.join(chunks), note


def extract(email_id, index, digest=None, *, include_lookup=False):
    row = db.get_email(email_id)
    if not row or row.get('remote_missing'):
        raise ValueError('来源邮件不存在或已移除')
    path = row.get('raw_path')
    if not path or not Path(path).is_file():
        raise ValueError('本地原始邮件未就绪，请先同步邮件')
    if Path(path).stat().st_size > 40 * 1024 * 1024:
        raise ValueError('原始邮件过大，暂不在线分析，请先拆分附件')
    att = parser.extract_attachment(path,index)
    if not att:
        raise ValueError('附件不存在或已变化，请重新选择')
    raw = att.get('payload') or b''
    if not raw or len(raw)>MAX_FILE:
        raise ValueError('附件为空或超过 10 MB，请先拆分')
    fingerprint = hashlib.sha256(raw).hexdigest()
    if digest is not None and fingerprint != digest:
        raise ValueError('附件内容已变化，请重新预览并选择')
    name = str(att.get('name') or '未命名附件')[:240]
    ext = kind(name)
    image = None
    try:
        if ext in ('png','jpg','jpeg','webp'):
            mime = 'jpeg' if ext in ('jpg','jpeg') else ext
            image = assistant_vision.prepare([{'data_url':f'data:image/{mime};base64,'+base64.b64encode(raw).decode()}])[0]
            text, note = '', '图片将交给多模态模型识别；请核对小字、金额和日期。'
        elif ext == 'pdf':
            text, note = _pdf(raw)
        elif ext in ('docx','xlsx','pptx'):
            text, note = _office(raw,ext)
        elif ext == 'xls':
            security = analyze_attachment(name, att.get('content_type') or '', raw)
            if security.get('has_macro'):
                raise ValueError('暂不分析含宏的旧版 XLS，请另存为无宏 XLSX 或 PDF')
            text, note = _legacy_xls(raw)
        elif ext in ('txt','csv','md'):
            text = None
            for encoding in ('utf-8-sig','utf-16' if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8','gb18030'):
                try:text=raw.decode(encoding);break
                except UnicodeError:continue
            if text is None or '\x00' in text:
                raise ValueError('文本编码不支持或内容不是纯文本，请另存为 UTF-8')
            note = '读取文本内容；CSV 不执行公式。'
        else:
            raise ValueError('暂不支持此附件格式，不会执行文件、宏或解压嵌套附件')
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError('附件无法解析，可能损坏、加密或格式不匹配，请转换后重试') from exc
    lookup_text = text
    if include_lookup and ext in ('docx', 'xlsx', 'pptx'):
        lookup_text = _office(raw, ext, expanded=True)[0]
    elif include_lookup and ext == 'xls':
        lookup_text = _legacy_xls(raw, expanded=True)[0]
    lookup_text = lookup_text[:MAX_LOCAL_LOOKUP_TEXT]
    truncated = len(text)>MAX_TEXT
    if not image and not text.strip():
        raise ValueError('附件未提取到文字；若内容为图片，请提供截图')
    if truncated:note += f' 内容较长，仅提供前 {MAX_TEXT} 个字符。'
    result = dict(email_id=email_id,index=index,digest=fingerprint,name=name,size=len(raw),text=text[:MAX_TEXT],note=note,truncated=truncated,image=image)
    if include_lookup and not image:
        result['lookup_text'] = lookup_text
    return result


def prepare(refs):
    if len(refs)>3:raise ValueError('每次最多选择 3 个附件')
    if len({(r['email_id'],r['index']) for r in refs}) != len(refs):raise ValueError('同一附件不能重复选择')
    result=[extract(r['email_id'],r['index'],r['digest'],include_lookup=True) for r in refs]
    if sum(r['size'] for r in result)>MAX_TOTAL:raise ValueError('所选附件合计超过 20 MB，请分批分析')
    remaining=MAX_COMBINED_TEXT
    for item in result:
        if len(item['text'])>remaining:
            item['text']=item['text'][:remaining];item['truncated']=True;item['note']+=' 达到本次总字数上限，后续内容未读取。'
        remaining-=len(item['text'])
    return result


def _question_terms(question):
    value = re.sub(
        r'请问|麻烦|帮我|帮忙|查找|查询|查一下|看一下|告诉我|是多少|是什么|有没有|附件|文件|里面|'
        r'手机号码|手机号|手机|电话号码|办公电话|电话|联系方式|电子邮箱|邮箱地址|邮箱|号码|信息|的|呢|吗',
        ' ', str(question or ''), flags=re.I,
    )
    terms = re.findall(r'[\u3400-\u9fff]{2,12}|[A-Za-z0-9_@.+-]{2,60}', value)
    return list(dict.fromkeys(term.casefold() for term in terms if len(term) >= 2))[:8]


def model_text(question, material):
    """Build bounded, query-aware attachment text for the internal model."""
    excerpt = str(material.get('text') or '')
    full = str(material.get('lookup_text') or excerpt)
    if len(full) <= len(excerpt):
        return excerpt
    terms = _question_terms(question)
    if not terms:
        return excerpt
    lines = full.splitlines()
    indexes = [index for index, line in enumerate(lines)
               if any(term in line.casefold() for term in terms)]
    if not indexes:
        return excerpt
    selected = []
    seen = set()
    for index in indexes:
        for nearby in range(max(0, index - 1), min(len(lines), index + 2)):
            if nearby not in seen:
                selected.append(lines[nearby])
                seen.add(nearby)
    relevant = '\n'.join(selected)[:14000]
    if relevant and relevant not in excerpt:
        return excerpt + '\n\n【按本次问题从附件其余位置命中的内容】\n' + relevant
    return excerpt


def history_text(question, materials):
    return question + ('\n（本次参考附件：'+'；'.join(f'{i+1}. {m["name"]}'+('〔节选〕' if m['truncated'] else '') for i,m in enumerate(materials))+'。历史不存附件正文；后续核对请重新选择附件。）' if materials else '')
