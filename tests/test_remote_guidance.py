"""Contextual phone suggestions are deterministic and never generate send authority."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.remote_guidance import guide
from app.remote_commands import canonicalize


class GuidanceTests(unittest.TestCase):
    def choices(self, response):
        return response.partition('接下来可以说：')[2]

    def test_unseen_pages_and_empty_results(self):
        state = dict(ids=[1,2], phone_page={'after_id':2})
        result = guide('本人\n小邮 · 新邮件\n范围：今天\n本次范围共 12 封。', '有什么新邮件？', state)
        self.assertIn('更多新邮件', self.choices(result))
        self.assertIn('查看第一封', self.choices(result))
        result = guide('本人\n小邮 · 新邮件\n没有符合范围的来信。', '有什么新邮件？', {})
        self.assertNotIn('查看第一封', self.choices(result))
        self.assertIn('查收邮件', self.choices(result))
        for error in ('时间无效，请重试。', '没有待展开的新邮件页。'):
            self.assertEqual(guide(error,'更多新邮件',state),error)

    def test_daily_and_task_source(self):
        result=guide('本人\n今日简报','今天有什么重要的？',dict(ids=[1],todo_ids=[8]))
        self.assertIn('查看第一封',self.choices(result))
        self.assertIn('查看第一项待办',self.choices(result))
        result=guide('待办详情','查看第一项待办',dict(todo_ids=[8,9],selected_todo=8))
        self.assertIn('查看原邮件',self.choices(result))
        self.assertIn('下一项',self.choices(result))

    def test_reading_guidance_keeps_body_and_obeys_boundaries(self):
        body='本人\n邮件正文：请问总结这封怎么用？\n\n当前第 1 / 2 封。可说“下一封”“上一封”“返回列表”；“回复这封”输入正文，或“总结这封”（AI）。'
        result=guide(body,'查看第一封',dict(ids=[1,2],selected=1))
        self.assertIn('邮件正文：请问总结这封怎么用？',result)
        self.assertIn('下一封',self.choices(result))
        self.assertNotIn('（AI）',result)
        result=guide('正文','查看第二封',dict(ids=[1,2],selected=2))
        self.assertIn('返回列表',self.choices(result))
        self.assertNotIn('下一封',self.choices(result))

    def test_reply_previews_errors_and_unknown_commands_are_untouched(self):
        preview='回复预览（尚未发送）\n确认发送 AABB1122'
        self.assertEqual(guide(preview,'回复：收到',dict(pending={'token':'AABB1122'})),preview)
        waiting='请直接输入回复正文'
        self.assertEqual(guide(waiting,'回复这封',dict(awaiting_reply=True)),waiting)
        for response in ('当前未选中可用邮件。','AI 暂不可用，邮件未发送。','确认编号不匹配，未发送。','手机邮件控制\n帮助'):
            self.assertEqual(guide(response,'查看第一封',dict(ids=[1],selected=1)),response)
        self.assertEqual(guide('结果','删除邮件',dict(ids=[1],selected=1)),'结果')
        result=guide('邮件服务器已接受回复。','确认发送 AABB1122',{})
        self.assertNotIn('回复这封',self.choices(result))
        self.assertNotIn('确认发送',self.choices(result))

    def test_recommended_commands_are_supported(self):
        scenarios=[('今天有什么重要的？',dict(ids=[1],todo_ids=[2])),
                   ('查看第一封',dict(ids=[1,2],selected=1)),
                   ('查看第一项待办',dict(todo_ids=[2,3],selected_todo=2)),
                   ('总结这封',dict(selected=1,_ai_enabled=True))]
        for request,state in scenarios:
            suggestions=self.choices(guide('结果',request,state)).splitlines()
            self.assertLessEqual(len([s for s in suggestions if s.startswith('• ')]),2)
            for line in suggestions:
                if line.startswith('• '):
                    command=line.partition('：“')[2].removesuffix('”')
                    self.assertIsNotNone(canonicalize(command),command)


if __name__ == '__main__':
    unittest.main()
