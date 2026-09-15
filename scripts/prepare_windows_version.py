"""Generate trustworthy Windows version metadata for the frozen executable."""
import os
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
raw = os.environ.get('MAILAI_RELEASE_VERSION', '1.0.4.0')
parts = [min(65535, int(value)) for value in re.findall(r'\d+', raw)[:4]]
parts.extend([0] * (4 - len(parts)))
version = tuple(parts)
text = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={version}, prodvers={version}, mask=0x3f, flags=0x0,
    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('080404b0', [
    StringStruct('CompanyName', 'langjiahui'),
    StringStruct('FileDescription', 'MailAI 邮件安全与效率助手'),
    StringStruct('FileVersion', '{'.'.join(map(str, version))}'),
    StringStruct('InternalName', 'MailAI'),
    StringStruct('LegalCopyright', 'Copyright langjiahui <1107048037@qq.com>'),
    StringStruct('OriginalFilename', 'MailAI.exe'),
    StringStruct('ProductName', 'MailAI'),
    StringStruct('ProductVersion', '{'.'.join(map(str, version))}')
  ])]), VarFileInfo([VarStruct('Translation', [2052, 1200])])]
)"""
target = ROOT / 'build' / 'windows-version.txt'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text, encoding='utf-8')
print(target)
