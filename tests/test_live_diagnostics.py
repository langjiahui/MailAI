"""Diagnostics must report live probe failures instead of configuration presence."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, system_settings


def main():
    names = (
        "DB_PATH", "IMAP_HOST", "IMAP_PORT", "IMAP_USER", "IMAP_PASSWORD",
        "IMAP_SSL", "IMAP_VERIFY_SSL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
        "SMTP_PASSWORD", "SMTP_USE_IMAP_CREDENTIALS", "SMTP_SSL", "SMTP_STARTTLS",
        "SMTP_VERIFY_SSL", "LLM_API_KEY", "LLM_MODEL",
    )
    old = {name: getattr(config, name) for name in names}
    try:
        with tempfile.TemporaryDirectory() as folder:
            config.DB_PATH = os.path.join(folder, "mailai.db")
            db.init_db()
            config.IMAP_HOST = "imap.example.test"
            config.IMAP_PORT = 993
            config.IMAP_USER = "user@example.test"
            config.IMAP_PASSWORD = "mail-secret"
            config.IMAP_SSL = config.IMAP_VERIFY_SSL = True
            config.SMTP_HOST = "smtp.example.test"
            config.SMTP_PORT = 465
            config.SMTP_USER = ""
            config.SMTP_PASSWORD = ""
            config.SMTP_USE_IMAP_CREDENTIALS = True
            config.SMTP_SSL = config.SMTP_VERIFY_SSL = True
            config.SMTP_STARTTLS = False
            config.LLM_API_KEY = "model-secret"
            config.LLM_MODEL = "broken-model"
            account_id = system_settings._account_key(config.IMAP_HOST, config.IMAP_USER)
            registry = {"last_account": account_id, "accounts": {account_id: {
                "user": config.IMAP_USER, "host": config.IMAP_HOST,
                "db_path": config.DB_PATH, "credential_storage": "vault", "visible": True,
            }}}
            with patch.object(system_settings, "_load_registry", return_value=registry), \
                 patch.object(system_settings, "account_password", return_value="mail-secret"), \
                 patch.object(system_settings, "test_mail_connection", return_value={"ok": True, "folders": 7}) as imap, \
                 patch.object(system_settings.smtp_client, "test_connection", return_value={"ok": True}) as smtp, \
                 patch.object(system_settings, "test_model", return_value={"ok": False, "message": "API Key 无效（HTTP 401）"}) as model:
                result = system_settings.diagnostics()
            by_name = {item["name"]: item for item in result["checks"]}
            assert not result["ok"], "a failed live model probe must fail diagnostics"
            assert by_name["邮箱收信"]["status"] == "pass" and by_name["邮箱收信"]["probe"] == "live"
            assert "7 个文件夹" in by_name["邮箱收信"]["detail"]
            assert by_name["SMTP 发信"]["status"] == "pass" and "未发送邮件" in by_name["SMTP 发信"]["detail"]
            assert by_name["AI 模型"]["status"] == "fail" and "401" in by_name["AI 模型"]["detail"]
            assert imap.call_count == smtp.call_count == model.call_count == 1
            assert "model-secret" not in str(result) and "mail-secret" not in str(result)

            with patch.object(system_settings, "_load_registry", return_value=registry), \
                 patch.object(system_settings, "account_password", return_value="mail-secret"), \
                 patch.object(system_settings, "test_mail_connection", side_effect=TimeoutError()), \
                 patch.object(system_settings.smtp_client, "test_connection", return_value={"ok": True}), \
                 patch.object(system_settings, "test_model", return_value={"ok": True, "message": "连接成功：OK"}):
                timeout_result = system_settings.diagnostics()
            timeout_check = next(item for item in timeout_result["checks"] if item["name"] == "邮箱收信")
            assert timeout_check["status"] == "fail" and "超时" in timeout_check["detail"]
        print("Live diagnostics detect model and mail failures without exposing secrets")
    finally:
        for name, value in old.items():
            setattr(config, name, value)


if __name__ == "__main__":
    main()
