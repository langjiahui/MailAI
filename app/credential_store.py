"""使用操作系统凭据库保存邮箱授权码；不可用时由调用方保留兼容配置。"""
import logging
import platform
import subprocess

log = logging.getLogger(__name__)
SERVICE = "MailAI"


def _keyring():
    try:
        import keyring
        return keyring
    except Exception:
        return None


def available() -> bool:
    return _keyring() is not None or platform.system() == "Darwin"


def save(account_key: str, secret: str) -> bool:
    keyring = _keyring()
    if not account_key or not secret:
        return False
    if not keyring and platform.system() == "Darwin":
        try:
            subprocess.run(["security", "add-generic-password", "-U", "-s", SERVICE,
                            "-a", account_key, "-w", secret], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
            return True
        except Exception:
            log.exception("macOS Keychain 写入失败")
            return False
    if not keyring:
        return False
    try:
        keyring.set_password(SERVICE, account_key, secret)
        return True
    except Exception:
        log.exception("系统凭据库写入失败")
        return False


def load(account_key: str) -> str:
    keyring = _keyring()
    if not account_key:
        return ""
    if not keyring and platform.system() == "Darwin":
        try:
            result = subprocess.run(["security", "find-generic-password", "-s", SERVICE,
                                     "-a", account_key, "-w"], check=True, capture_output=True,
                                    text=True, timeout=8)
            return result.stdout.strip()
        except Exception:
            return ""
    if not keyring:
        return ""
    try:
        return keyring.get_password(SERVICE, account_key) or ""
    except Exception:
        log.exception("系统凭据库读取失败")
        return ""


def delete(account_key: str):
    keyring = _keyring()
    if not account_key:
        return
    if not keyring and platform.system() == "Darwin":
        subprocess.run(["security", "delete-generic-password", "-s", SERVICE, "-a", account_key],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        return
    if not keyring:
        return
    try:
        keyring.delete_password(SERVICE, account_key)
    except Exception:
        pass
