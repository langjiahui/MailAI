"""Chat mail lists remain readable after WeChat wraps them on a narrow screen."""
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.remote_briefing import phone_time, render_mails


class MailListFormatTests(unittest.TestCase):
    def test_local_short_time_and_separate_entries(self):
        stamp = '2026-09-28 05:46:18+00:00'
        self.assertEqual(phone_time(stamp), datetime.fromisoformat(stamp).astimezone().strftime(
            '%m月%d日 %H:%M' if datetime.now().year == 2026 else '%Y年%m月%d日 %H:%M'))
        rows = [
            {'subject': '第一封邮件', 'from_name': '项目同事', 'date': stamp},
            {'subject': 'IMC基础平台通知', 'from_name': 'chenleyuan', 'date': stamp},
        ]
        rendered = render_mails(rows, include_summary=False)
        self.assertIn('1. 第一封邮件\n项目同事 · ', rendered)
        self.assertIn('\n\n2. IMC基础平台通知\nchenleyuan · ', rendered)
        self.assertNotIn('+00:00', rendered)
        self.assertNotIn('00:00IMC', rendered)

    def test_summary_is_its_own_line_and_missing_sync_is_clear(self):
        self.assertEqual(phone_time('尚无成功同步记录'), '尚无成功同步记录')
        rendered = render_mails([{'subject': '主题\n伪造行', 'from_addr': 'sender@example.test',
                                  'date': None, 'summary': '待处理'}])
        self.assertIn('1. 主题 伪造行', rendered)
        self.assertIn('\n摘要：待处理', rendered)


if __name__ == '__main__':
    unittest.main()
