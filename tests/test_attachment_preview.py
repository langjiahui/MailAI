"""Local previews do not execute HTML or follow embedded document links."""
import io
from pathlib import Path
import sys
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.attachment_preview import preview_attachment, MAX_BYTES


def main():
    def preview(name, payload):
        return preview_attachment({'name': name, 'payload': payload})
    document = io.BytesIO()
    with zipfile.ZipFile(document, 'w') as archive:
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>通知正文</w:t></w:r></w:p></w:body></w:document>')
    assert preview('通知.docx', document.getvalue())['html'] == '<p>通知正文</p>'
    assert preview('bad.docx', b'invalid')['kind'] == 'unsupported'
    assert preview('test.html', b'<script>alert(1)</script>')['kind'] == 'unsupported'
    assert preview('test.txt', b'<script>alert(1)</script>')['text'].startswith('<script>')
    assert preview('big.txt', b'x' * (MAX_BYTES + 1))['kind'] == 'unsupported'
    from PIL import Image
    image = io.BytesIO(); Image.new('RGB', (8, 8)).save(image, 'PNG')
    assert preview('photo.png', image.getvalue())['kind'] == 'image'
    from pypdf import PdfWriter
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    pdf = io.BytesIO(); writer.write(pdf)
    assert preview('report.pdf', pdf.getvalue())['kind'] == 'pdf'
    writer.encrypt('password'); encrypted = io.BytesIO(); writer.write(encrypted)
    assert preview('private.pdf', encrypted.getvalue())['kind'] == 'unsupported'
    print('PASS DOCX, PDF, encrypted PDF, image, text, malformed and oversized previews')


if __name__ == '__main__': main()
