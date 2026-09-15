"""Historical imports stay fast and model results are reused."""
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, pipeline
from app.llm import analyze


def main():
    old_db = config.DB_PATH
    old_days, old_limit = config.HISTORY_AI_DAYS, config.HISTORY_AI_LIMIT
    with tempfile.TemporaryDirectory() as folder:
        try:
            config.DB_PATH = os.path.join(folder, "mailai.db")
            config.HISTORY_AI_DAYS = 30
            config.HISTORY_AI_LIMIT = 200
            db.init_db()

            now = datetime.now().astimezone()
            recent = {"date": (now - timedelta(days=2)).isoformat()}
            old = {"date": (now - timedelta(days=90)).isoformat()}
            assert pipeline._ordered_history_uids([2, 9, 4]) == [9, 4, 2]
            assert pipeline._history_ai_allowed(recent, None)
            assert pipeline._history_ai_allowed(recent, 200)
            assert not pipeline._history_ai_allowed(recent, 201)
            assert not pipeline._history_ai_allowed(old, 1)
            assert not pipeline._history_ai_allowed({"date": ""}, 1)
            assert 0 < config.HISTORY_DEEP_SCAN_LIMIT <= 1000

            email = {
                "message_id": "<cache-1@example.test>", "subject": "项目进度",
                "from_addr": "sender@example.test", "body_text": "请明天下午提交报告。",
                "snippet": "请明天下午提交报告。",
            }
            calls = []

            def fake_chat(*_args, **_kwargs):
                calls.append(1)
                return {"category": "项目工作", "priority": "高", "summary": "提交报告",
                        "todos": [{"title": "提交报告", "deadline": None}]}

            with patch.object(analyze.client, "available", return_value=True), \
                 patch.object(analyze.client, "chat_json", side_effect=fake_chat):
                first = analyze.work_analysis(email)
                second = analyze.work_analysis(email)
            assert first == second and len(calls) == 1
            assert first["category"] == "项目工作"
        finally:
            config.DB_PATH = old_db
            config.HISTORY_AI_DAYS, config.HISTORY_AI_LIMIT = old_days, old_limit
    print("Historical AI budget, newest-first ordering and result cache passed")


if __name__ == "__main__":
    main()
