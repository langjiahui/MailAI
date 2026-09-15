"""处置策略与熔断回归测试。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db, pipeline


def main():
    old_path = config.DB_PATH
    old_limit = config.AUTO_ACTION_MAX_PER_RUN
    old_mode = pipeline.get_action_policy()["mode"]
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        config.DB_PATH = path
        config.AUTO_ACTION_MAX_PER_RUN = 2
        db.init_db()

        pipeline.set_action_mode("observe")
        assert pipeline._resolve_action("quarantine") == (
            "inbox", False, "观察模式：仅记录处置建议"
        )

        pipeline.set_action_mode("review")
        assert pipeline._resolve_action("spam") == (
            "inbox", False, "人工确认模式：等待用户确认"
        )

        pipeline.set_action_mode("auto")
        pipeline._reset_action_guard()
        assert pipeline._resolve_action("quarantine")[:2] == ("quarantine", True)
        assert pipeline._resolve_action("spam")[:2] == ("spam", True)
        blocked = pipeline._resolve_action("quarantine")
        assert blocked[:2] == ("inbox", False)
        policy = pipeline.get_action_policy()
        assert policy["tripped"] is True
        assert policy["moved"] == 2
        assert policy["blocked"] == 1
        print("✅ 三级处置模式与单批熔断测试通过")
    finally:
        config.DB_PATH = old_path
        config.AUTO_ACTION_MAX_PER_RUN = old_limit
        try:
            pipeline.set_action_mode(old_mode)
        except Exception:
            pass
        if os.path.exists(path):
            os.unlink(path)


if __name__ == "__main__":
    main()
