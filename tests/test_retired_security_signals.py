"""Retired noisy signals and built-in business trust must repair existing rows."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, pipeline


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mailai.db")):
        db.init_db()
        email_id = db.upsert_email({
            "uid": 1, "folder": "INBOX", "from_addr": "build@gitlab.baocloud.cn",
            "subject": "构建通知", "date": "2026-09-08 12:00:00", "score": 80,
            "verdict": "suspicious", "status": "inbox", "recommended_status": "inbox",
            "review_source": "rule", "final_landing_domain": "gitlab.baocloud.cn",
            "findings": [
                {"code": "AUTH_NONE", "detail": "无认证信息", "weight": 5},
                {"code": "DOMAIN_LOOKALIKE", "detail": "gitlab.baocloud.cn", "weight": 40},
                {"code": "URL_FINAL_LOOKALIKE", "detail": "gitlab.baocloud.cn", "weight": 35},
            ],
        })
        result = pipeline.repair_retired_security_signals()
        repaired = db.get_email(email_id)
        assert result["updated"] == 1
        assert repaired["findings"] == []
        assert repaired["score"] == 0 and repaired["verdict"] == "clean"
        assert pipeline.repair_retired_security_signals()["skipped"] is True
    print("Retired AUTH_NONE and trusted business-domain history repair passed")


if __name__ == "__main__":
    main()
