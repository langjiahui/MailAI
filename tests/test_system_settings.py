"""系统配置掩码、账号级存储隔离和退出测试（不连接真实邮箱）。"""
import os
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, system_settings


def main():
    names = ["DB_PATH", "RAW_DIR", "IMAP_HOST", "IMAP_PORT", "IMAP_USER", "IMAP_PASSWORD",
             "IMAP_SSL", "IMAP_VERIFY_SSL", "LLM_API_KEY"]
    old = {name: getattr(config, name) for name in names}
    old_paths = (system_settings.ENV_PATH, system_settings.REGISTRY_PATH, system_settings.ACCOUNTS_DIR)
    old_test = system_settings.test_mail_connection
    old_smtp_test = system_settings.smtp_client.test_connection
    with tempfile.TemporaryDirectory() as td, \
         patch.object(system_settings.credential_store, "save", return_value=False), \
         patch.object(system_settings.credential_store, "load", return_value="") as load_credential, \
         patch.object(system_settings.credential_store, "delete") as delete_credential:
        try:
            system_settings.ENV_PATH = os.path.join(td, ".env")
            system_settings.REGISTRY_PATH = os.path.join(td, "registry.json")
            system_settings.ACCOUNTS_DIR = os.path.join(td, "accounts")
            system_settings.test_mail_connection = lambda values: {"ok": True, "folders": 5}
            system_settings.smtp_client.test_connection = lambda values: {"ok": True, "host": values["smtp_host"]}
            config.LLM_API_KEY = "sk-1234567890-secret"

            # “测试连接”必须使用尚未保存的表单值，且不得把测试草稿写入配置文件。
            draft_model = {"base_url": "https://draft.example.test/openapi", "model": "draft-model",
                           "multimodal_model": "draft-vision", "api_key": "draft-secret",
                           "verify_ssl": False}
            model_response = {"choices": [{"message": {"content": "OK"}}]}
            with patch.object(system_settings.llm_client, "chat_completion",
                              return_value=model_response) as model_call:
                assert system_settings.test_model(draft_model)["ok"] is True
            kwargs = model_call.call_args.kwargs
            assert kwargs["base_url"] == draft_model["base_url"]
            assert kwargs["model"] == draft_model["model"]
            assert kwargs["api_key"] == draft_model["api_key"]
            assert kwargs["verify_ssl"] is False
            assert not os.path.exists(system_settings.ENV_PATH), "测试连接不应保存表单草稿"

            first = {"host": "imap.example.test", "port": 993, "user": "one@example.test",
                     "password": "password-one", "ssl": True, "verify_ssl": True,
                     "smtp_host": "smtp.example.test", "smtp_port": 465, "smtp_ssl": True,
                     "smtp_starttls": False, "smtp_verify_ssl": True}
            second = {**first, "user": "two@example.test", "password": "password-two"}
            # IMAP success is enough to enter the mailbox; SMTP can be repaired later.
            system_settings.smtp_client.test_connection = lambda values: (_ for _ in ()).throw(OSError('smtp unavailable'))
            first_result = system_settings.login_mail(first)
            assert first_result['smtp']['ok'] is False and first_result['smtp_warning']
            assert system_settings.current_smtp_verified() is False
            assert first_result['credential_warning']
            assert 'password-one' not in open(system_settings.ENV_PATH).read()
            assert system_settings.account_password(first_result['account_id']) == 'password-one'
            system_settings.smtp_client.test_connection = lambda values: {"ok": True, "host": values["smtp_host"]}
            system_settings.login_mail(first)
            first_db = config.DB_PATH
            system_settings.login_mail(second)
            second_db = config.DB_PATH
            assert first_db != second_db
            assert os.path.exists(first_db) and os.path.exists(second_db)

            public = system_settings.public_config()
            assert "password-two" not in str(public)
            assert "sk-1234567890-secret" not in str(public)
            assert public["mail"]["logged_in"] is True
            assert all(item['credential_storage'] == 'session' for item in public['accounts'])
            from app.account_context import snapshot
            # A stale vault entry must not supersede the freshly entered secret.
            with patch.object(system_settings.credential_store, 'load', return_value='stale-password'):
                assert snapshot(first_result['account_id'])['IMAP_PASSWORD'] == 'password-one'
                session_password = system_settings._session_credentials.pop(first_result['account_id'])
                assert system_settings.account_password(first_result['account_id']) == ''
                system_settings._session_credentials[first_result['account_id']] = session_password

            # 在设置中维护非当前账号，只更新凭据，不得偷偷切换当前邮箱。
            first_id = next(item["id"] for item in public["accounts"] if item["user"] == first["user"])
            with patch.object(system_settings.credential_store, "save", return_value=True):
                updated = system_settings.update_mail_account(first_id, {**first, "password": "new-password-one"})
            assert updated["active_unchanged"] is False
            assert config.IMAP_USER == second["user"] and config.DB_PATH == second_db
            assert system_settings._load_registry()["last_account"] != first_id

            # 浏览账号时只持久化下次启动偏好，不得中断当前请求的数据库上下文。
            load_credential.return_value = 'new-password-one'
            remembered = system_settings.remember_mail_account(first_id)
            assert remembered['account_id'] == first_id
            assert config.IMAP_USER == second['user'] and config.DB_PATH == second_db
            assert system_settings._load_registry()['last_account'] == first_id
            public = system_settings.public_config()
            assert next(item for item in public['accounts'] if item['id'] == first_id)['active'] is True

            # 模拟覆盖安装后浏览器状态丢失：配置里仍是旧账号，也必须恢复持久化偏好。
            config.IMAP_USER = second['user']
            config.IMAP_PASSWORD = ''
            system_settings.initialize_current_account()
            assert config.IMAP_USER == first['user'] and config.DB_PATH == first_db
            load_credential.return_value = 'password-two'
            system_settings.remember_mail_account(next(item['id'] for item in public['accounts'] if item['user'] == second['user']))

            # 模拟重启：配置中没有当前账号时，自动恢复最近的可用已保存账号。
            config.IMAP_USER = ""
            config.IMAP_PASSWORD = ""
            load_credential.return_value = "password-two"
            system_settings.initialize_current_account()
            assert config.IMAP_USER == second["user"] and config.IMAP_PASSWORD == "password-two"
            assert config.DB_PATH == second_db
            load_credential.return_value = ""

            system_settings.logout_mail(clear_history=False)
            assert config.IMAP_USER == "" and config.IMAP_PASSWORD == ""
            logged_out = system_settings.public_config()
            assert logged_out["mail"]["logged_in"] is False
            assert len(logged_out["accounts"]) == 1
            assert logged_out["accounts"][0]["user"] == first["user"]
            assert os.path.exists(second_db), "保留历史时不应删除账号数据库"
            delete_credential.assert_called_once()

            # 已退出且只剩一个可见账号时，也应能直接移除；保留历史但不再显示账号卡片。
            first_id = logged_out["accounts"][0]["id"]
            first_db_path = first_db
            inactive_result = system_settings.logout_mail(clear_history=False, account_id=first_id)
            assert inactive_result["user"] == first["user"]
            assert os.path.exists(first_db_path)
            assert system_settings.public_config()["accounts"] == []

            system_settings.login_mail(second)
            second_raw = config.RAW_DIR
            with open(os.path.join(second_raw, "sample.eml"), "wb") as f:
                f.write(b"mail")
            result = system_settings.logout_mail(clear_history=True)
            assert result["history_cleared"] is True
            assert not os.path.exists(second_db) and not os.path.exists(second_raw)
            cleared = system_settings.public_config()
            assert all(item["user"] != second["user"] for item in cleared["accounts"])
        finally:
            system_settings._session_credentials.clear()
            system_settings.test_mail_connection = old_test
            system_settings.smtp_client.test_connection = old_smtp_test
            system_settings.ENV_PATH, system_settings.REGISTRY_PATH, system_settings.ACCOUNTS_DIR = old_paths
            for name, value in old.items():
                setattr(config, name, value)
    print("✅ 系统配置掩码与邮箱账号隔离测试通过")


if __name__ == "__main__":
    main()
