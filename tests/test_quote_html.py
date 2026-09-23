"""Reply quotes retain basic structure without active mail content."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.web.routes.mail_read import safe_quote_html


def test_safe_quote_html():
    html = '<p><strong>项目</strong><script>alert(1)</script><img src="https://tracker.test/x"></p><table><tr><td>一</td></tr></table><a href="javascript:alert(1)">危险链接</a>'
    clean = safe_quote_html(html)
    assert '<strong>项目</strong>' in clean and '<table>' in clean
    assert 'script' not in clean and 'alert(1)' not in clean
    assert '<img' not in clean and 'javascript:' not in clean


if __name__ == '__main__':
    test_safe_quote_html()
