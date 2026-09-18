"""反馈分析脚本：fp/fn 聚合、规则统计与处置建议。"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, db

_spec = importlib.util.spec_from_file_location(
    "analyze_feedback", ROOT / "scripts" / "analyze_feedback.py")
analyze_feedback = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(analyze_feedback)


def _insert(uid, sender, verdict, feedback, date, findings=None, note=""):
    with db.conn() as c:
        c.execute(
            "INSERT INTO emails(uid,folder,from_addr,subject,date,verdict,feedback,feedback_note,"
            "findings,created_at,remote_missing) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
            (uid, "INBOX", sender, f"样本{uid}", date, verdict, feedback, note,
             json.dumps(findings or [], ensure_ascii=False), date),
        )


def main():
    with tempfile.TemporaryDirectory() as root, \
            patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
            patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()
        now = datetime.now().isoformat(timespec="seconds")
        old = (datetime.now() - timedelta(days=200)).isoformat(timespec="seconds")

        # 误报：同一域 3 次、同一规则 3 次 → 应产生两条建议
        for i in (1, 2, 3):
            _insert(i, f"news{i}@partner-example.com", "suspicious", "fp", now,
                    findings=[{"code": "URGENCY", "weight": 10}])
        # 漏报：同一域 2 次 → 建议黑名单复核
        _insert(4, "a@evil-example.net", "clean", "fn", now)
        _insert(5, "b@evil-example.net", "clean", "fn", now)
        # 窗口外的反馈不计入
        _insert(6, "c@partner-example.com", "suspicious", "fp", old)

        report = analyze_feedback.analyze(days=90)
        assert report["totals"] == {"fp": 3, "fn": 2}, report["totals"]
        assert report["fp"]["by_domain"] == [("partner-example.com", 3)]
        assert report["fp"]["by_rule"] == [("URGENCY", 3)]
        assert report["fn"]["by_domain"] == [("evil-example.net", 2)]
        text = "\n".join(report["suggestions"])
        assert "partner-example.com" in text and "白名单" in text
        assert "URGENCY" in text and "规则中心" in text
        assert "evil-example.net" in text and "黑名单" in text
        assert len(report["fp"]["samples"]) == 3

        # 空库不报错
        with tempfile.TemporaryDirectory() as root2, \
                patch.object(config, "DB_PATH", os.path.join(root2, "empty.db")):
            db.init_db()
            empty = analyze_feedback.analyze(days=30)
            assert empty["totals"] == {"fp": 0, "fn": 0}
            assert empty["suggestions"] == []

    print("✅ 反馈分析聚合、建议生成与空库测试通过")


if __name__ == "__main__":
    main()
