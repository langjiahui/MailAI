"""Mobile help stays brief, navigable and truthful for each chat channel."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.remote_commands import canonicalize
from app.remote_control import _execute
from app.remote_help import render


class MobileHelpTests(unittest.TestCase):
    def test_short_menu_and_topic_navigation(self):
        menu = render()
        self.assertLess(len(menu), 260)
        self.assertIn('帮助 更多', menu)
        self.assertNotIn('｜', menu)
        for topic in ('邮件', '待办', '回复', '附件', '设置', '更多'):
            with self.subTest(topic=topic):
                command = canonicalize('帮助 ' + topic)
                self.assertEqual(command, '帮助 ' + topic)
                self.assertLess(len(render(topic)), 380)
                self.assertNotEqual(render(topic), menu)
                self.assertNotIn('｜', render(topic))

    def test_help_before_account_selection_and_ai_capability(self):
        self.assertEqual(canonicalize('怎么用'), '帮助')
        self.assertEqual(canonicalize('help 回复'), '帮助 回复')
        self.assertEqual(_execute('test', {}, {}, '帮助', 'weixin'), render())
        self.assertEqual(_execute('test', {}, {}, '帮助 回复', 'weixin'), render('回复'))
        self.assertNotIn('起草回复', render('回复'))
        self.assertIn('起草回复', render('回复', ai_enabled=True))

    def test_attachment_help_matches_transport(self):
        self.assertIn('把第二个附件发给我', render('附件', 'weixin'))
        dingtalk = _execute('test', {}, {}, '帮助 附件', 'dingtalk')
        self.assertIn('不支持', dingtalk)
        self.assertNotIn('把第二个附件发给我', dingtalk)


if __name__ == '__main__':
    unittest.main()
