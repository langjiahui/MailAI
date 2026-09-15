"""Conversation context must only describe actual historical mail."""
import os
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import threads


def main():
    current = {"id": 7, "uid": 7, "thread_id": "thread-1"}
    with patch.object(threads.db, "list_thread_emails", return_value=[current]), \
         patch.object(threads, "get_thread_summary") as summary:
        context = threads.build_thread_context(current)
    assert context["history_count"] == 0
    assert context["history"] == [] and context["summary"] == ""
    summary.assert_not_called()
    print("✅ 空会话上下文不会重复显示当前邮件")


if __name__ == "__main__":
    main()
