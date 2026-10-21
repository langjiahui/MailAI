"""Bounded MIME projection for large local imports; originals remain on disk.

Only headers and small text bodies reach the existing mail parser. Binary parts
are hashed/decoded in chunks, never materialized as a whole attachment.
"""
import base64
import hashlib
import mmap
import quopri
import re
import uuid
from email import policy
from email.parser import BytesParser

TEXT_BUDGET = 8 * 1024**2
HEADER_LIMIT = 256 * 1024
CHUNK = 64 * 1024


def project(path):
    replacements = {}
    budget = 0
    part_count = 0
    with open(path, 'rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
        raw_hash = hashlib.sha256()
        for pos in range(0, len(data), CHUNK):
            raw_hash.update(data[pos:pos + CHUNK])

        def entity(start, end, depth=0):
            nonlocal budget, part_count
            part_count += 1
            if depth > 20 or part_count > 1000:
                raise ValueError('邮件 MIME 层级或分段过多，请单独检查此邮件')
            match = re.search(rb'\r?\n\r?\n', data[start:min(end, start + HEADER_LIMIT)])
            if not match:
                raise ValueError('邮件头过大或不完整，请重新导出此邮件')
            body = start + match.end()
            budget += body - start
            if budget > TEXT_BUDGET:
                raise ValueError('邮件头和正文超过 8 MB，请单独检查此邮件')
            headers = data[start:body]
            msg = BytesParser(policy=policy.default).parsebytes(headers, headersonly=True)
            boundary = msg.get_boundary()
            if msg.get_content_maintype() == 'multipart':
                if not boundary or len(boundary) > 200:
                    raise ValueError('邮件 MIME 边界无效，请重新导出此邮件')
                pattern = re.compile(rb'(?m)^--' + re.escape(boundary.encode('ascii')) + rb'(--)?[ \t]*(?:\r?\n|$)')
                output = [headers]
                previous = None
                closed = False
                for marker in pattern.finditer(data, body, end):
                    if previous is not None:
                        stop = marker.start()
                        if data[max(previous, stop-2):stop] == b'\r\n': stop -= 2
                        elif data[max(previous, stop-1):stop] == b'\n': stop -= 1
                        output.append(entity(previous, stop, depth + 1))
                        output.append(b'\r\n')
                    output.append(marker.group())
                    if marker.group(1):
                        closed = True
                        break
                    previous = marker.end()
                if not closed:
                    raise ValueError('邮件 MIME 内容不完整，请重新导出此邮件')
                return b''.join(output)
            # Preserve small embedded messages intact. Huge forwarded messages
            # need separate import, rather than silently losing their contents.
            binary = msg.get_content_maintype() != 'text' or msg.get_filename() or msg.get_content_disposition() == 'attachment'
            if not binary or msg.get_content_maintype() == 'message':
                budget += end - body
                if budget > TEXT_BUDGET:
                    raise ValueError('邮件正文或嵌套邮件超过 8 MB，请单独导出嵌套邮件后重试')
                return data[start:end]
            encoding = str(msg.get('Content-Transfer-Encoding', '')).lower().strip()
            if encoding not in ('base64', 'quoted-printable', '7bit', '8bit', 'binary', ''):
                raise ValueError('大邮件附件编码不受支持，请重新导出为标准 EML')
            digest = hashlib.sha256()
            size = 0
            pending = b''
            for pos in range(body, end, CHUNK):
                chunk = pending + data[pos:min(pos + CHUNK, end)]
                pending = b''
                if encoding == 'base64':
                    chunk = re.sub(rb'\s+', b'', chunk)
                    n = len(chunk) // 4 * 4
                    pending = chunk[n:]
                    chunk = base64.b64decode(chunk[:n], validate=True)
                elif encoding == 'quoted-printable':
                    last = chunk.rfind(b'=', max(0, len(chunk)-3))
                    if last >= 0:
                        pending, chunk = chunk[last:], chunk[:last]
                    chunk = quopri.decodestring(chunk)
                digest.update(chunk)
                size += len(chunk)
            if pending:
                if encoding == 'base64':
                    chunk = base64.b64decode(pending + b'=' * (-len(pending) % 4), validate=True)
                else:
                    chunk = quopri.decodestring(pending)
                digest.update(chunk)
                size += len(chunk)
            marker = uuid.uuid4().hex
            replacements[marker] = dict(digest=digest.hexdigest(), size=size, name=msg.get_filename() or '未命名',
                                        cid=msg.get('Content-ID', ''), disposition=msg.get_content_disposition(),
                                        content_type=msg.get_content_type())
            # The marker only exists in this in-memory projection, never in the
            # preserved original or the semantic signature's identity headers.
            return b'X-MailAI-Stream-Part: ' + marker.encode() + b'\r\n' + headers + (base64.b64encode(marker.encode()) if encoding == 'base64' else marker.encode())

        projected = entity(0, len(data))
    return projected, replacements, raw_hash.hexdigest()
