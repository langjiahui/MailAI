"""Portable, integrity-checked account migration archives.

Local snapshots remain the fast rollback mechanism.  This module deliberately
creates an inert data package: credentials and runnable server operations never
cross the machine boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import sqlite3
import stat
import struct
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from . import config, db

FORMAT_VERSION = 3
MAGIC = b"MAILAI3\0"
MAX_ARCHIVE_SIZE = 20 * 1024**3
MAX_FILES = 1_000_000
MAX_EXPANDED_SIZE = 100 * 1024**3


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and "\\" not in name and ":" not in name and ".." not in path.parts


def _encrypt(source: str, target: str, password: str):
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise RuntimeError("当前安装缺少迁移包加密组件，请重新安装或升级 MailAI") from exc
    salt, nonce = os.urandom(16), os.urandom(12)
    key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**15, r=8, p=1, dklen=32, maxmem=64 * 1024**2)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(MAGIC)
    ciphertext_length = os.path.getsize(source) + 16
    with open(target, "wb") as output:
        output.write(MAGIC + salt + nonce + struct.pack(">Q", ciphertext_length))
        with open(source, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                output.write(encryptor.update(chunk))
        output.write(encryptor.finalize())
        output.write(encryptor.tag)


def _decrypt(source: str, target: str, password: str):
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise RuntimeError("当前安装缺少迁移包解密组件，请重新安装或升级 MailAI") from exc
    with open(source, "rb") as stream:
        if stream.read(len(MAGIC)) != MAGIC:
            raise ValueError("迁移包格式无效")
        salt, nonce, length = stream.read(16), stream.read(12), struct.unpack(">Q", stream.read(8))[0]
        if length > MAX_ARCHIVE_SIZE or length != os.path.getsize(source) - len(MAGIC) - 36:
            raise ValueError("迁移包长度无效")
        ciphertext_length = length - 16
        stream.seek(-16, os.SEEK_END)
        tag = stream.read(16)
        stream.seek(len(MAGIC) + 36)
    try:
        key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**15, r=8, p=1, dklen=32, maxmem=64 * 1024**2)
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(MAGIC)
        with open(source, "rb") as stream, open(target, "wb") as output:
            stream.seek(len(MAGIC) + 36)
            remaining = ciphertext_length
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk: raise ValueError("迁移包长度无效")
                output.write(decryptor.update(chunk))
                remaining -= len(chunk)
            output.write(decryptor.finalize())
    except Exception as exc:
        try: os.unlink(target)
        except FileNotFoundError: pass
        raise ValueError("迁移密码错误或文件已损坏") from exc


def _zip_path(source: str, temp_dir: str, password: str) -> str:
    if os.path.getsize(source) > MAX_ARCHIVE_SIZE:
        raise ValueError("迁移包超过支持的大小")
    with open(source, "rb") as stream:
        encrypted = stream.read(len(MAGIC)) == MAGIC
    if encrypted:
        if not password:
            raise ValueError("该迁移包已加密，请输入迁移密码")
        target = os.path.join(temp_dir, "package.zip")
        _decrypt(source, target, password)
        return target
    return source


def _validate_archive(path: str) -> tuple[dict, dict[str, str]]:
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError("迁移包不是有效的 MailAI 备份") from exc
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES or sum(item.file_size for item in infos) > MAX_EXPANDED_SIZE:
            raise ValueError("迁移包展开后的大小或文件数量超出限制")
        names = {item.filename for item in infos}
        if not {"manifest.json", "mailai.db", "checksums.json"}.issubset(names):
            raise ValueError("迁移包内容不完整")
        for item in infos:
            if not _safe_member(item.filename) or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("迁移包包含不安全的文件路径")
            if item.compress_size and item.file_size > max(256 * 1024**2, item.compress_size * 1000):
                raise ValueError("迁移包包含异常压缩内容")
        manifest = json.loads(archive.read("manifest.json"))
        checksums = json.loads(archive.read("checksums.json"))
        if manifest.get("format_version") != FORMAT_VERSION:
            raise ValueError("不支持的迁移包版本")
        if not isinstance(manifest.get("account"), dict) or not isinstance(manifest.get("content"), dict):
            raise ValueError("迁移包清单结构无效")
        if not isinstance(checksums, dict):
            raise ValueError("迁移包校验清单无效")
        for name, expected in checksums.items():
            if (name not in names or not _safe_member(name) or not isinstance(expected, str)
                    or len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected)):
                raise ValueError("迁移包校验清单不完整")
            digest = hashlib.sha256()
            with archive.open(name) as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            actual = digest.hexdigest()
            if actual != expected:
                raise ValueError(f"迁移包文件校验失败：{name}")
        if set(checksums) != names - {"checksums.json"}:
            raise ValueError("迁移包存在未校验内容")
        return manifest, checksums


def _normalize_range_bound(value: str, *, end: bool) -> str | None:
    """Normalize an optional date bound (YYYY-MM-DD or ISO datetime) for comparisons."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        if len(value) == 10:
            parsed = datetime.strptime(value, "%Y-%m-%d")
            return parsed.strftime("%Y-%m-%d") + ("T23:59:59" if end else "T00:00:00")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("导出时间范围格式无效，请使用 YYYY-MM-DD") from exc


def _select_by_date_range(connection, *, since: str | None, until: str | None) -> int:
    """Delete out-of-range emails from the snapshot and prune dependent rows.

    Emails whose effective timestamp cannot be parsed are kept: dropping mail
    silently is worse than including a little extra.
    """
    if not since and not until:
        return 0
    stamp = "datetime(COALESCE(NULLIF(date,''),created_at))"
    clauses, params = [], []
    if since:
        clauses.append(f"{stamp} < datetime(?)")
        params.append(since)
    if until:
        clauses.append(f"{stamp} > datetime(?)")
        params.append(until)
    removed = connection.execute(
        f"DELETE FROM emails WHERE {' OR '.join(clauses)}", params).rowcount
    connection.execute("DELETE FROM todos WHERE email_id IS NOT NULL AND email_id NOT IN (SELECT id FROM emails)")
    connection.execute("DELETE FROM url_chains WHERE email_id NOT IN (SELECT id FROM emails)")
    connection.execute("DELETE FROM briefing_dismissed WHERE email_id NOT IN (SELECT id FROM emails)")
    connection.execute(
        "UPDATE audit_logs SET email_id=NULL WHERE email_id IS NOT NULL "
        "AND email_id NOT IN (SELECT id FROM emails)")
    connection.execute(
        "UPDATE threads SET last_email_id=NULL WHERE last_email_id IS NOT NULL "
        "AND last_email_id NOT IN (SELECT id FROM emails)")
    connection.execute(
        "UPDATE drafts SET reply_to_email_id=NULL WHERE reply_to_email_id IS NOT NULL "
        "AND reply_to_email_id NOT IN (SELECT id FROM emails)")
    return max(0, removed or 0)


def create(*, include_raw: bool = True, password: str = "", since: str = "", until: str = "") -> dict:
    """Create a v3 package in the backup directory and return download metadata."""
    from . import system_settings
    if password and len(password) < 12:
        raise ValueError("迁移密码至少需要 12 位")
    since_bound = _normalize_range_bound(since, end=False)
    until_bound = _normalize_range_bound(until, end=True)
    if since_bound and until_bound and since_bound > until_bound:
        raise ValueError("导出时间范围起点不能晚于终点")
    backup_dir = os.path.join(config.DATA_DIR, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    filename = f"MailAI-Portable-{stamp}.mailai-backup"
    target = os.path.join(backup_dir, filename)
    partial = target + ".part"
    try:
        with tempfile.TemporaryDirectory(prefix=".mailai-export-", dir=backup_dir) as temp_dir:
            snapshot_path = os.path.join(temp_dir, "mailai.db")
            system_settings._copy_database(config.DB_PATH, snapshot_path)
            system_settings._freeze_restored_side_effects(snapshot_path)
            objects: dict[str, str] = {}
            missing_raw = 0
            with system_settings._sqlite_connection(snapshot_path) as connection:
                excluded = _select_by_date_range(connection, since=since_bound, until=until_bound)
                rows = connection.execute("SELECT id,raw_path FROM emails WHERE raw_path IS NOT NULL").fetchall()
                for email_id, raw_path in rows:
                    if not include_raw:
                        connection.execute("UPDATE emails SET raw_path=NULL WHERE id=?", (email_id,))
                        continue
                    real = os.path.realpath(raw_path)
                    root = os.path.realpath(config.RAW_DIR)
                    if os.path.commonpath([real, root]) != root or not os.path.isfile(real):
                        connection.execute("UPDATE emails SET raw_path=NULL WHERE id=?", (email_id,))
                        missing_raw += 1
                        continue
                    digest = _sha256_file(real)
                    reference = f"objects/{digest[:2]}/{digest}"
                    objects.setdefault(reference, real)
                    connection.execute("UPDATE emails SET raw_path=? WHERE id=?", (reference, email_id))
                counts = connection.execute("SELECT COUNT(*),SUM(raw_path IS NOT NULL) FROM emails").fetchone()
                connection.execute("DELETE FROM sync_state")
                connection.execute("DELETE FROM sync_jobs")
            created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            manifest = {
                "format_version": FORMAT_VERSION, "minimum_app_version": "1.0",
                "database_schema_version": 1, "created_at": created_at,
                "source_platform": platform.system(),
                "account": {"email": config.IMAP_USER, "imap_host": config.IMAP_HOST},
                "content": {"emails": int(counts[0] or 0), "raw_messages": int(counts[1] or 0),
                            "missing_raw_messages": missing_raw, "includes_raw_mail": include_raw},
                "selection": {"since": since, "until": until, "excluded_emails": excluded},
                "credentials_included": False, "encrypted": bool(password),
            }
            members = {"mailai.db": snapshot_path}
            members.update(objects)
            plain_zip = os.path.join(temp_dir, "portable.zip")
            checksums = {name: _sha256_file(path) for name, path in members.items()}
            manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
            checksums["manifest.json"] = hashlib.sha256(manifest_bytes).hexdigest()
            with zipfile.ZipFile(plain_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("manifest.json", manifest_bytes)
                for name, path in members.items():
                    archive.write(path, name)
                archive.writestr("checksums.json", json.dumps(checksums, ensure_ascii=False, indent=2))
            if password:
                _encrypt(plain_zip, partial, password)
            else:
                shutil.copyfile(plain_zip, partial)
            os.chmod(partial, stat.S_IRUSR | stat.S_IWUSR)
            os.replace(partial, target)
    finally:
        try: os.unlink(partial)
        except FileNotFoundError: pass
    size = os.path.getsize(target)
    db.add_audit_log(None, "portable_backup", actor="user", reason=f"导出便携迁移包 {filename}",
                     meta={"size": size, "encrypted": bool(password), "since": since, "until": until})
    return {"ok": True, "filename": filename, "size": size, "created_at": created_at,
            "encrypted": bool(password), "download_url": "/api/system/portable-backups/download/" + filename}


def inspect(source: str, *, password: str = "") -> dict:
    with tempfile.TemporaryDirectory(prefix=".mailai-inspect-") as temp_dir:
        path = _zip_path(source, temp_dir, password)
        manifest, _ = _validate_archive(path)
        with zipfile.ZipFile(path) as archive:
            expanded_size = sum(item.file_size for item in archive.infolist())
        package_email = str(manifest.get("account", {}).get("email") or "").casefold()
        return {"ok": True, **manifest, "source_size": os.path.getsize(source),
                "expanded_size": expanded_size,
                "current_account_matches": bool(config.IMAP_USER and package_email == config.IMAP_USER.casefold()),
                "current_account": config.IMAP_USER or ""}


def restore_current(source: str, *, password: str = "") -> dict:
    """Replace the logged-in account using a verified package and atomic rollback."""
    from . import system_settings
    raw_parent = os.path.dirname(os.path.abspath(config.RAW_DIR))
    os.makedirs(raw_parent, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".mailai-import-", dir=raw_parent) as temp_dir:
        archive_path = _zip_path(source, temp_dir, password)
        manifest, _ = _validate_archive(archive_path)
        email = str(manifest.get("account", {}).get("email") or "").casefold()
        if not config.IMAP_USER or email != config.IMAP_USER.casefold():
            raise ValueError("请先登录迁移包所属的同一邮箱账号")
        with zipfile.ZipFile(archive_path) as archive:
            expanded_size = sum(item.file_size for item in archive.infolist())
        free = shutil.disk_usage(raw_parent).free
        reserve = max(256 * 1024**2, os.path.getsize(config.DB_PATH) * 2 if os.path.isfile(config.DB_PATH) else 0)
        if free < expanded_size + reserve:
            needed = expanded_size + reserve - free
            raise ValueError(f"磁盘空间不足，至少还需要释放 {max(1, needed // 1024**2)} MB")
        staged_db, staged_raw = os.path.join(temp_dir, "mailai.db"), os.path.join(temp_dir, "staged-raw")
        os.makedirs(staged_raw)
        with zipfile.ZipFile(archive_path) as archive:
            with archive.open("mailai.db") as src, open(staged_db, "wb") as dst: shutil.copyfileobj(src, dst)
            for info in archive.infolist():
                if not info.filename.startswith("objects/") or info.is_dir(): continue
                destination = os.path.join(staged_raw, *PurePosixPath(info.filename).parts)
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with archive.open(info) as src, open(destination, "wb") as dst: shutil.copyfileobj(src, dst)
        with system_settings._sqlite_connection(staged_db) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("迁移包数据库校验失败")
            connection.row_factory = sqlite3.Row
            connection.executescript(db.SCHEMA)
            db._run_migrations(connection)
            # UIDs are scoped to a server folder generation and cannot cross a
            # machine/provider boundary.  Keep imported messages visible as
            # local archives until the first sync rebinds them by Message-ID.
            connection.execute("UPDATE emails SET uid=-id,is_local_archive=1,remote_missing=0")
            for email_id, reference in connection.execute("SELECT id,raw_path FROM emails WHERE raw_path IS NOT NULL").fetchall():
                if not reference.startswith("objects/") or not _safe_member(reference):
                    raise ValueError("迁移包数据库包含无效的邮件原文引用")
                if not os.path.isfile(os.path.join(staged_raw, *PurePosixPath(reference).parts)):
                    raise ValueError("迁移包缺少邮件原文")
                connection.execute("UPDATE emails SET raw_path=? WHERE id=?", (os.path.join(config.RAW_DIR, *PurePosixPath(reference).parts), email_id))
        system_settings._freeze_restored_side_effects(staged_db)
        safety = system_settings.create_backup(include_raw=True)
        rollback_db, rollback_raw = os.path.join(temp_dir, "rollback.db"), os.path.join(temp_dir, "rollback-raw")
        system_settings._copy_database(config.DB_PATH, rollback_db)
        moved = swapped = False
        try:
            if os.path.exists(config.RAW_DIR): os.replace(config.RAW_DIR, rollback_raw); moved = True
            os.replace(staged_raw, config.RAW_DIR); swapped = True
            system_settings._copy_database(staged_db, config.DB_PATH)
        except BaseException:
            if swapped and os.path.exists(config.RAW_DIR): shutil.rmtree(config.RAW_DIR)
            if moved: os.replace(rollback_raw, config.RAW_DIR)
            system_settings._copy_database(rollback_db, config.DB_PATH)
            raise
        if os.path.exists(rollback_raw): shutil.rmtree(rollback_raw)
    db.init_db()
    db.add_audit_log(None, "portable_backup_import", actor="user", reason="从便携迁移包恢复", meta={"safety_backup": safety["filename"]})
    return {"ok": True, "safety_backup": safety["filename"], "account": email,
            "emails": manifest.get("content", {}).get("emails", 0), "requires_resync": True}


def stored_path(filename: str) -> str:
    if filename != os.path.basename(filename) or not filename.startswith("MailAI-Portable-") or not filename.endswith(".mailai-backup"):
        raise ValueError("迁移包文件名无效")
    path = os.path.join(config.DATA_DIR, "backups", filename)
    if not os.path.isfile(path): raise FileNotFoundError(filename)
    return path


def list_stored() -> list[dict]:
    directory = os.path.join(config.DATA_DIR, "backups")
    if not os.path.isdir(directory): return []
    result = []
    for name in sorted(os.listdir(directory), reverse=True):
        try: path = stored_path(name)
        except (ValueError, FileNotFoundError): continue
        result.append({"filename": name, "size": os.path.getsize(path),
                       "created_at": datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat(timespec="seconds"),
                       "portable": True})
    return result[:30]


def delete_stored(filename: str) -> dict:
    """Delete one validated portable package from managed storage."""
    path = stored_path(filename)
    size = os.path.getsize(path)
    os.unlink(path)
    db.add_audit_log(None, "portable_backup_delete", actor="user",
                     reason=f"删除便携迁移包 {filename}", meta={"size": size})
    return {"ok": True, "filename": filename, "deleted_size": size}


def stage_upload(payload: bytes, *, password: str = "") -> dict:
    if not payload or len(payload) > MAX_ARCHIVE_SIZE:
        raise ValueError("迁移包为空或超过支持的大小")
    directory = os.path.join(config.DATA_DIR, "imports")
    os.makedirs(directory, exist_ok=True)
    # Imported packages are short-lived and named by the server, never by an
    # untrusted browser filename.
    for item in Path(directory).glob("*.upload"):
        try:
            if time.time() - item.stat().st_mtime > 24 * 3600: item.unlink()
        except OSError: pass
    token = uuid.uuid4().hex
    path = os.path.join(directory, token + ".upload")
    partial = path + ".part"
    try:
        Path(partial).write_bytes(payload)
        os.chmod(partial, stat.S_IRUSR | stat.S_IWUSR)
        result = inspect(partial, password=password)
        os.replace(partial, path)
    finally:
        try: os.unlink(partial)
        except FileNotFoundError: pass
    return {**result, "import_token": token}


def stage_file(source: str, *, password: str = "") -> dict:
    """Validate a server-streamed upload and atomically retain it for restore."""
    directory = os.path.join(config.DATA_DIR, "imports")
    os.makedirs(directory, exist_ok=True)
    token = uuid.uuid4().hex
    path = os.path.join(directory, token + ".upload")
    result = inspect(source, password=password)
    os.replace(source, path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return {**result, "import_token": token}


def staged_path(token: str) -> str:
    if len(token) != 32 or any(char not in "0123456789abcdef" for char in token):
        raise ValueError("导入令牌无效")
    path = os.path.join(config.DATA_DIR, "imports", token + ".upload")
    if not os.path.isfile(path): raise FileNotFoundError("迁移包已过期，请重新选择")
    return path


def restore_staged(token: str, *, password: str = "") -> dict:
    path = staged_path(token)
    result = restore_current(path, password=password)
    try: os.unlink(path)
    except FileNotFoundError: pass
    return result


def discard_staged(token: str) -> dict:
    path = staged_path(token)
    os.unlink(path)
    return {"ok": True}
