"""Real Word 97 fixture and rendered PDF regression tests."""
import base64
import io
from pathlib import Path
import sys
import zipfile
import zlib
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.document_preview import word_preview, pdf_preview

DOC = "eJztnE1ME0EUgF+3pbSV0pY/a1GpYNBEYzBiwsEYiIiIBlBIPJgY+YekBYP8yA0PJiaEWGOMHkwMJHgxMRqJBy+iB28qFw7iBQ8kYPypXAwHu743OwstBWlNQyW8r3k7szM7815nZn9es6+TH1wzI888n2EFx8EIIdUK5rAyA8oefccJUCDLQqqqUpEXRWU2FV/HXssJDWa80mbZhZNqoIkvRkmHZmTl6tDJoQOg7pomnrUOk6iqY928jk9sR+XeaFR9NHRMVgzH6bxASUN5I1OdHyihOPpJNN/wlPIqy/vTKNlJs4aJlfcQuY4Y5v9n4P73vi/XZ9s8gdl+O/waMtXPBebulrQvXqSaT7ceXVKK7JA3XDD8stqjnvFPDdmTbTKTSOR9fjHZdjAbRFpNlRHOoZyoci8/580n2ywmQeAzuf1tIaQVKZdNAfOEJWjz2msdg66nmTPZTndp5EP60vwzWxJDsg1gkksGOMCGy6ADUwWM4lMMUPpTVSjFy0M1dEE3+KFB+OTkmGaJWwfdRmrlrcRfaTVF930MykoX1BFM6apUDi3Qir30Yj894IVazHejtIntFWjHsgrU1Ym1K9EuWvR7hdzKq5ZQKvMpYXm6oCnOiMbaL1nU4JQ5ENOyr8dB8aPRV9Gwakz7MT2PBtJQdGL9UexHWbcXgDoYwDaN2JIG8EiM2stwWDrkoMdqcSVa6YM+3PZg2yZs7YWzmGvDwaVB9eL3L7LcdENwEg1vF31On/EVklA+UolB7JvA6DREleolXiMEncD8G2PmidRxGIdByChKfO+0NvOXT0ucJ0vilTAMwzAMwzAMs3kIoUdtskV7l1Qyc+PhwmJNu/PxbQsc2Pf8I/kobllHQo4fORnzvzfSYoZhGIZhGIZhGIZh4uVv/r8y9W7qwaFc55176P8fXHzC/j/DMAzDMAzDMAzDbE6En49iBO3leHqLnt6UTwXtfx2smNpQtoEW3UzRn+koDlnvAoohAMgELfqeItVzULbL+h2gvYCfi7ITZRfKbpQ8WU+SH5YPJel/ELYqFNDQJeIxTorIi24YiGv95ECKQe+L1pDZqoVETGjVFau12YsyKPOHoR4aoBF80BKXXp10XL3h3yeWNuI1eBm1cEFEtzRDOaZN0CsCPlaLQFkLDygGOofi0Q9h+lOgTmj1i2iYATiN2luXIm4ojKNLBJusxX7UTyNuAj0+JkbVS/pXfvP47ClB/fGOvztMP8MwDJMc/gBK5iIQ"


def main():
    result = word_preview(zlib.decompress(base64.b64decode(DOC)), '.doc')
    assert '项目自查通知' in result['html'] and '负责人：测试' in result['text']
    package = io.BytesIO()
    with zipfile.ZipFile(package, 'w') as archive:
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>通知标题</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>')
    result = word_preview(package.getvalue(), '.docx')
    assert '<strong>通知标题</strong>' in result['html']
    assert '<table>' in result['html'] and '<script>' not in result['html']
    from pypdf import PdfWriter
    writer=PdfWriter(); writer.add_blank_page(width=300,height=400); writer.add_blank_page(width=500,height=600)
    pdf=io.BytesIO(); writer.write(pdf)
    first, second = pdf_preview(pdf.getvalue(),0), pdf_preview(pdf.getvalue(),1)
    assert first['page_count']==2 and second['page']==1
    assert base64.b64decode(first['data']).startswith(b'\x89PNG')
    assert first['data'] != second['data']
    try: pdf_preview(pdf.getvalue(),2)
    except ValueError: pass
    else: raise AssertionError('Out of bounds page accepted')
    print('PASS real binary DOC Chinese text, DOCX tables/bold/escaping, PDF raster pages and bounds')


if __name__=='__main__': main()
