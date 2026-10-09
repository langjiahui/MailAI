"""Guard application-owned validation/status messages that can reach the interface.

External exception details and user/model-generated content are intentionally not
translated. This test reads sources only and never contacts an account or model.
"""
import ast
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HAN = re.compile(r'[\u3400-\u9fff]')


def message_pattern(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return ''.join(part.value if isinstance(part, ast.Constant) else '{' + str(index) + '}'
                       for index, part in enumerate(node.values))
    return ''


def message_candidates(node):
    if isinstance(node, ast.IfExp):
        yield from message_candidates(node.body)
        yield from message_candidates(node.orelse)
    else:
        yield node


class ServiceCopyTests(unittest.TestCase):
    def test_application_error_and_status_copy_has_english(self):
        source = (ROOT / 'app/web/static/i18n-catalog.js').read_text()
        catalogue = json.loads(source.split('const MAILAI_UI_COPY = ', 1)[1]
                               .split(';\nconst MAILAI_I18N_CHINESE', 1)[0])
        translated = {pair[0] for pair in catalogue.values() if isinstance(pair[1], str)}
        missing = []
        checked = set()
        for path in (ROOT / 'app').rglob('*.py'):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                candidates = []
                if isinstance(node, ast.Call):
                    name = node.func.id if isinstance(node.func, ast.Name) else ''
                    if name in ('ValueError', 'RuntimeError', 'ui_text', 'ui_format'):
                        candidates = node.args[:1]
                    elif name == 'HTTPException':
                        candidates = node.args[1:2] + [kw.value for kw in node.keywords if kw.arg == 'detail']
                if isinstance(node, ast.Dict):
                    candidates += [value for key, value in zip(node.keys, node.values)
                                   if isinstance(key, ast.Constant) and key.value in
                                   ('message', 'detail', 'msg', 'hint', 'error', 'credential_warning',
                                    'smtp_warning', 'sync_error', 'sync_message')]
                if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
                    # Custom errors (upload conflicts, model capabilities, remote
                    # message recovery) reach the same UI as built-in errors.
                    candidates += node.exc.args
                for candidate in (part for value in candidates for part in message_candidates(value)):
                    pattern = message_pattern(candidate)
                    if HAN.search(pattern):
                        checked.add(pattern)
                        if pattern not in translated:
                            missing.append(f'{path.relative_to(ROOT)}:{candidate.lineno}: {pattern}')
        self.assertGreater(len(checked), 500)
        self.assertEqual(missing, [], 'Add English service copy:\n' + '\n'.join(missing))


if __name__ == '__main__':
    unittest.main()
