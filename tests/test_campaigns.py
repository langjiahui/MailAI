"""相似攻击邮件应聚合，普通邮件不应被牵连。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.security import campaigns


def main():
    rows = [
        {"id": 1, "from_addr": "notice@evil.example", "subject": "邮箱即将停用，请立即验证",
         "body_text": "请立即点击链接验证账号", "urls": ["https://verify.evil.example/a"],
         "score": 78, "verdict": "phishing", "date": "2026-09-03T10:00:00"},
        {"id": 2, "from_addr": "service@evil.example", "subject": "邮箱即将停用，请立即验证",
         "body_text": "请立即点击链接验证账号", "urls": ["https://verify.evil.example/b"],
         "score": 66, "verdict": "suspicious", "date": "2026-09-03T09:00:00"},
        {"id": 3, "from_addr": "colleague@company.example", "subject": "项目周报",
         "body_text": "本周进度正常", "urls": [], "score": 0, "verdict": "clean",
         "date": "2026-09-03T08:00:00"},
    ]
    groups = campaigns.cluster(rows)
    assert len(groups) == 1
    assert groups[0]["email_ids"] == [1, 2]
    assert "相同链接目标" in groups[0]["signals"]
    assert campaigns.for_email(2, groups)["size"] == 2
    assert campaigns.for_email(3, groups) is None
    print("✅ 同源攻击聚类与影响面分析通过")


if __name__ == "__main__":
    main()
