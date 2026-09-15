import io
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from openpyxl import Workbook
from app.attachment_preview import preview_attachment


def main():
    book = Workbook()
    sheet = book.active; sheet.title = '方案'
    sheet.append(['项目', '数量', '备注'])
    sheet.append(['测试', 12, '<script>alert(1)</script>'])
    sheet['A300'] = 'not included'
    book.create_sheet('空表')
    buffer = io.BytesIO(); book.save(buffer)
    result = preview_attachment({'name':'方案.xlsx', 'payload':buffer.getvalue()})
    assert result['kind'] == 'spreadsheet'
    assert result['sheets'][0]['rows'][1] == ['测试', '12', '<script>alert(1)</script>']
    assert len(result['sheets'][0]['rows']) <= 200
    assert result['sheets'][1]['rows'] == []
    assert preview_attachment({'name':'bad.xls','payload':b'invalid'})['kind'] == 'unsupported'
    print('PASS Excel worksheets, row limit, cell values, empty and damaged files')


if __name__ == '__main__': main()
