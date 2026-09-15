"""IMAP 连接与操作：拉取新邮件、移动文件夹（隔离/恢复）。"""
import logging
import re
import ssl
import certifi

from imapclient import IMAPClient

from . import config, db

log = logging.getLogger(__name__)


class RawMessageBatch:
    """Sized UID plan, with at most one body download in flight."""
    def __init__(self, client, folder, uids):
        self.client, self.folder, self.uids = client, folder, list(uids)

    def __len__(self):
        return len(self.uids)

    def newest_first(self):
        return RawMessageBatch(self.client, self.folder, sorted(self.uids, reverse=True))

    def __iter__(self):
        for uid in self.uids:
            # Processing the previous message may have selected a quarantine or
            # spam folder. UIDs are folder-scoped, so always reselect the source.
            self.client.select_folder(self.folder, readonly=True)
            data = self.client.fetch([uid], ['BODY.PEEK[]'])
            raw = data.get(uid, {}).get(b'BODY[]')
            if raw is not None:
                yield uid, raw


def mailbox_role(mailbox: dict) -> str:
    """Map server special-use flags/names to a stable local role."""
    flags = {str(flag).lower() for flag in mailbox.get("flags", [])}
    if "\\sent" in flags:
        return "sent"
    if "\\drafts" in flags:
        return "draft"
    if "\\trash" in flags:
        return "trash"
    if "\\junk" in flags:
        return "spam"
    if "\\quarantine" in flags:
        return "quarantine"
    if "\\all" in flags:
        return "all"
    if "\\archive" in flags:
        return "archive"
    name = str(mailbox.get("name") or "").strip().casefold()
    conventional = {
        'inbox': 'inbox', '收件箱': 'inbox',
        "sent": "sent", "sent items": "sent", "sent messages": "sent", "已发送": "sent",
        "drafts": "draft", "draft": "draft", "草稿箱": "draft", "草稿": "draft",
        "trash": "trash", "deleted items": "trash", "deleted messages": "trash",
        "已删除": "trash", "废纸篓": "trash", "垃圾箱": "trash",
        "junk": "spam", "junk e-mail": "spam", "junk email": "spam",
        "spam": "spam", "垃圾邮件": "spam",
        "quarantine": "quarantine", "隔离区": "quarantine",
        "all mail": "all", "全部邮件": "all", "所有邮件": "all",
        "archive": "archive", "archives": "archive", "归档": "archive",
    }
    return conventional.get(name, "folder")


class MailClient:
    def __init__(self):
        self.client: IMAPClient | None = None

    def __enter__(self):
        if config.IMAP_VERIFY_SSL:
            ssl_context = ssl.create_default_context(cafile=certifi.where())
        else:
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
        self.client = IMAPClient(
            config.IMAP_HOST, port=config.IMAP_PORT, ssl=config.IMAP_SSL,
            ssl_context=ssl_context, timeout=30,
        )
        self.client.login(config.IMAP_USER, config.IMAP_PASSWORD)
        return self

    def __exit__(self, *exc):
        try:
            self.client.logout()
        except Exception:
            pass

    @staticmethod
    def _uid_validity(info) -> int:
        if not isinstance(info, dict):
            return 0
        try:
            return int(info.get(b"UIDVALIDITY") or info.get("UIDVALIDITY") or 0)
        except (TypeError, ValueError):
            return 0

    def select_folder(self, folder: str, *, readonly: bool = False, reset_generation: bool = False):
        info = self.client.select_folder(folder, readonly=readonly)
        validity = self._uid_validity(info)
        if validity:
            db.observe_uid_validity(folder, validity, reset=reset_generation)
        return info

    def ensure_folder(self, name: str):
        folders = [self._text(f[2]) for f in self.client.list_folders()]
        if name in folders:
            return
        try:
            self.client.create_folder(name)
            log.info("创建文件夹: %s", name)
        except Exception as e:
            err = str(e).lower()
            if "exist" in err or "已存在" in err:
                log.info("文件夹已存在: %s", name)
            else:
                raise

    @staticmethod
    def _text(value) -> str:
        return value.decode(errors="replace") if isinstance(value, bytes) else str(value)

    def list_mailboxes(self) -> list[dict]:
        """列出服务端文件夹和计数，不改变任何邮件状态。"""
        result = []
        for flags, delimiter, name in self.client.list_folders():
            text_flags = sorted(self._text(flag) for flag in flags)
            selectable = "\\noselect" not in {flag.lower() for flag in text_flags}
            info = {}
            if selectable:
                try:
                    status = self.client.folder_status(name, ["MESSAGES", "UNSEEN"])
                    if isinstance(status, dict):
                        info = status
                except Exception:
                    log.debug("STATUS 不可用，回退到只读 SELECT: %s", name, exc_info=True)
                if not info:
                    info = self.client.select_folder(name, readonly=True)
                    info = dict(info)
                    info[b"UNSEEN"] = len(self.client.search(["UNSEEN"]))
            result.append({
                "name": self._text(name),
                "delimiter": self._text(delimiter),
                "flags": text_flags,
                "selectable": selectable,
                "messages": int(info.get(b"MESSAGES", info.get("MESSAGES", info.get(b"EXISTS", 0))) or 0),
                "unseen": int(info.get(b"UNSEEN", info.get("UNSEEN", 0)) or 0),
            })
        return result

    def mailbox_for_role(self, role: str) -> str | None:
        """Return a selectable special-use folder without opening every mailbox."""
        for flags, _delimiter, name in self.client.list_folders():
            text_flags = sorted(self._text(flag) for flag in flags)
            selectable = "\\noselect" not in {flag.lower() for flag in text_flags}
            item = {"name": self._text(name), "flags": text_flags}
            if selectable and mailbox_role(item) == role:
                return item["name"]
        return None

    def ensure_spam_folder(self) -> str:
        """Use the mailbox provider's real Junk folder, creating the configured fallback only if absent."""
        target = self.mailbox_for_role("spam")
        if not target:
            target = config.SPAM_FOLDER
            self.ensure_folder(target)
        return target

    def ensure_quarantine_folder(self) -> str:
        """Use an existing quarantine mailbox, creating the configured fallback only if absent."""
        target = self.mailbox_for_role("quarantine")
        if not target:
            target = config.QUARANTINE_FOLDER
            self.ensure_folder(target)
        return target

    def move_to_spam(self, uid: int, source_folder: str) -> tuple[int, str]:
        """Move one message into the server-designated Junk folder."""
        target = self.ensure_spam_folder()
        return self.move(uid, source_folder, target), target

    def move_to_quarantine(self, uid: int, source_folder: str) -> tuple[int, str]:
        """Move one message into the configured/existing quarantine folder."""
        target = self.ensure_quarantine_folder()
        return self.move(uid, source_folder, target), target

    def ensure_trash_folder(self) -> str:
        """Resolve the server-designated trash folder, creating a safe fallback."""
        target = self.mailbox_for_role("trash")
        if not target:
            target = "Trash"
            self.ensure_folder(target)
        return target

    def move_to_trash(self, uid: int, source_folder: str) -> tuple[int, str]:
        """Move one message to the server trash, creating a conventional Trash folder if absent."""
        target = self.ensure_trash_folder()
        return self.move(uid, source_folder, target), target

    def copy_many(self, uids: list[int], source_folder: str,
                  target_folder: str) -> dict[int, int | None]:
        """Copy one batch and return any UID mapping the server provides.

        A tagged OK means the copy itself succeeded even when older/provider-
        specific IMAP servers omit COPYUID. The caller persists that phase
        before deleting the sources, so retries never copy the same batch twice.
        """
        planned = list(dict.fromkeys(int(uid) for uid in uids))
        if not planned:
            return {}
        self.ensure_folder(target_folder)
        self.select_folder(source_folder)
        present = {int(value) for value in self.client.search(["UID", ",".join(map(str, planned))])}
        if present != set(planned):
            raise RuntimeError("部分源邮件已不存在，请重新同步后重试")
        response = self.client.copy(planned, target_folder)
        exact = self._copyuid_mapping(response, planned)
        return {uid: exact.get(uid) for uid in planned}

    def delete_many(self, uids: list[int], source_folder: str):
        """Delete only the requested source UIDs after their copy phase committed."""
        planned = list(dict.fromkeys(int(uid) for uid in uids))
        if not planned:
            return
        self.select_folder(source_folder)
        present = {int(value) for value in self.client.search(["UID", ",".join(map(str, planned))])}
        if not present:
            return  # A prior attempt completed remotely before local commit.
        self.client.add_flags(sorted(present), ["\\Deleted"], silent=True)
        self.client.expunge(sorted(present))
        self.select_folder(source_folder, readonly=True)
        remaining = {int(value) for value in self.client.search(["UID", ",".join(map(str, present))])}
        if remaining:
            raise RuntimeError("服务器未删除部分源邮件，将稍后重试")

    def set_seen(self, uid: int, folder: str, seen: bool):
        self.set_seen_many([uid], folder, seen)

    def set_seen_many(self, uids: list[int], folder: str, seen: bool):
        planned = list(dict.fromkeys(int(uid) for uid in uids))
        if not planned:
            return
        self.select_folder(folder)
        method = self.client.add_flags if seen else self.client.remove_flags
        method(planned, ["\\Seen"], silent=True)

    def set_flagged(self, uid: int, folder: str, flagged: bool):
        self.select_folder(folder)
        method = self.client.add_flags if flagged else self.client.remove_flags
        method([uid], ["\\Flagged"], silent=True)

    def find_message_uid(self, folder: str, message_id: str) -> int | None:
        """Resolve a stale UID from a stable Message-ID inside one exact folder."""
        message_id = str(message_id or "").strip()
        if not folder or not message_id:
            return None
        self.select_folder(folder, readonly=True)
        matches = [int(value) for value in self.client.search(
            ["HEADER", "Message-ID", message_id]
        )]
        return max(matches) if matches else None

    @staticmethod
    def _uid_sequence(value: str) -> list[int]:
        result = []
        for part in str(value or "").split(","):
            if not part:
                continue
            if ":" not in part:
                result.append(int(part))
                continue
            first, last = (int(item) for item in part.split(":", 1))
            step = 1 if last >= first else -1
            result.extend(range(first, last + step, step))
        return result

    @classmethod
    def _copyuid_mapping(cls, response, expected: list[int]) -> dict[int, int]:
        match = re.search(r"COPYUID\s+\d+\s+([0-9,:]+)\s+([0-9,:]+)(?=\D|$)", str(response), re.I)
        if not match:
            return {}
        sources, targets = cls._uid_sequence(match.group(1)), cls._uid_sequence(match.group(2))
        if len(sources) != len(targets) or set(sources) != set(expected) or len(set(targets)) != len(targets):
            return {}
        return dict(zip(sources, targets))

    def move_many(self, uids: list[int], source_folder: str, target_folder: str) -> dict[int, int]:
        """Safely copy/delete a UID batch with a single IMAP round-trip per phase.

        UIDPLUS supplies an exact source-to-target mapping. If a provider omits
        that mapping, keep every source intact and use the conservative,
        idempotent one-message implementation to identify the copied messages.
        """
        planned = list(dict.fromkeys(int(uid) for uid in uids))
        if not planned:
            return {}
        if source_folder == target_folder:
            return {uid: uid for uid in planned}
        if len(planned) == 1:
            return {planned[0]: self.move(planned[0], source_folder, target_folder)}
        if not self.client.has_capability("UIDPLUS"):
            raise RuntimeError("服务器不支持安全的 UID 定向移动，请使用原邮箱客户端移动")
        self.ensure_folder(target_folder)
        self.select_folder(source_folder)
        present = {int(value) for value in self.client.search(["UID", ",".join(map(str, planned))])}
        if present != set(planned):
            raise RuntimeError("部分源邮件已不存在，请重新同步后重试")

        self.select_folder(target_folder, readonly=True)
        self.select_folder(source_folder)
        response = self.client.copy(planned, target_folder)
        mapping = self._copyuid_mapping(response, planned)
        if not mapping:
            # Never delete a UIDNEXT range here: another client may have added
            # messages concurrently. move() reuses the just-created copy when
            # its stable Message-ID/size can be proven, otherwise it safely
            # leaves the source untouched and reports a partial failure.
            recovered = {}
            for uid in planned:
                try:
                    recovered[uid] = self.move(uid, source_folder, target_folder)
                except Exception:
                    # Keep successful mappings so callers can persist partial
                    # progress. The failed source remains intact by move()'s
                    # verification contract and can be retried independently.
                    log.warning("批量移动回退失败 source=%s uid=%s", source_folder, uid)
            return recovered

        self.select_folder(source_folder)
        still_present = {int(value) for value in self.client.search(["UID", ",".join(map(str, planned))])}
        if still_present != set(planned):
            raise RuntimeError("批量复制后源邮件状态发生变化；为避免误删已停止操作")
        self.client.add_flags(planned, ["\\Deleted"], silent=True)
        self.client.expunge(planned)
        return mapping

    def move(self, uid: int, source_folder: str, target_folder: str):
        """先确认副本 UID，再仅删除指定源邮件；绝不全文件夹 EXPUNGE。

        少数企业 IMAP 支持 UIDPLUS，却不会在 COPY 响应里返回 COPYUID。
        此时比较复制前后的 Message-ID/邮件大小来确认新增副本。若上一次
        操作已复制但未能删除源邮件，则复用并去重已有副本，不再次复制。
        只有确认目标副本后才删除源邮件。
        """
        if source_folder == target_folder:
            return uid
        if not self.client.has_capability("UIDPLUS"):
            raise RuntimeError("服务器不支持安全的 UID 定向移动，请使用原邮箱客户端移动")
        self.ensure_folder(target_folder)
        self.select_folder(source_folder)
        if not self.client.search(["UID", str(uid)]):
            raise RuntimeError("源邮件已不存在，请重新同步文件夹")
        message_id = ""
        source_size = 0
        try:
            source_data = self.client.fetch(
                [uid], ["BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]", "RFC822.SIZE"]
            )
            item = source_data.get(uid, {})
            header = item.get(b"BODY[HEADER.FIELDS (MESSAGE-ID)]") or item.get(b"BODY[]") or b""
            source_size = int(item.get(b"RFC822.SIZE") or item.get("RFC822.SIZE") or 0)
            if isinstance(header, str):
                header = header.encode("utf-8", "ignore")
            header_match = re.search(br"(?im)^Message-ID:\s*(<[^>]+>)", header)
            if header_match:
                message_id = header_match.group(1).decode("utf-8", "ignore")
        except Exception:
            log.debug("读取源邮件 Message-ID 失败 uid=%s", uid, exc_info=True)

        def matching_target_uids() -> list[int]:
            if not message_id:
                return []
            matches = [int(value) for value in self.client.search(
                ["HEADER", "Message-ID", message_id]
            )]
            if not matches or source_size <= 0:
                return matches
            sizes = self.client.fetch(matches, ["RFC822.SIZE"])
            return [value for value in matches if int(
                (sizes.get(value, {}) or {}).get(b"RFC822.SIZE")
                or (sizes.get(value, {}) or {}).get("RFC822.SIZE") or -1
            ) == source_size]

        target_info = self.select_folder(target_folder, readonly=True)
        try:
            target_uidnext = int(target_info.get(b"UIDNEXT") or target_info.get("UIDNEXT") or 0)
        except (AttributeError, TypeError, ValueError):
            target_uidnext = 0
        target_uids_before = {int(value) for value in self.client.search(["ALL"])}
        existing_matches = matching_target_uids()

        # A prior copy may have succeeded before MailAI could resolve its UID.
        # Reuse that exact Message-ID/size match so retries remain idempotent.
        target_uid = max(existing_matches) if existing_matches else 0
        if target_uid:
            duplicates = [value for value in existing_matches if value != target_uid]
            if duplicates:
                self.select_folder(target_folder)
                self.client.add_flags(duplicates, ["\\Deleted"], silent=True)
                self.client.expunge(duplicates)
                log.warning(
                    "清理移动重试产生的重复目标副本 folder=%s uids=%s",
                    target_folder, duplicates,
                )
            log.info(
                "复用上次移动留下的目标副本 source_uid=%s target_uid=%s",
                uid, target_uid,
            )

        if not target_uid:
            self.select_folder(source_folder)
            response = self.client.copy([uid], target_folder)
            match = re.search(r"COPYUID\s+\d+\s+(\d+)\s+(\d+)(?=\D|$)", str(response), re.I)
            if match and int(match.group(1)) != uid:
                raise RuntimeError("服务器返回的源邮件 UID 不一致；源邮件未删除")
            target_uid = int(match.group(2)) if match else 0
        else:
            response = None
        if not target_uid:
            self.select_folder(target_folder, readonly=True)
            if message_id:
                candidates = [candidate for candidate in matching_target_uids()
                              if candidate not in set(existing_matches)]
            else:
                candidates = [int(candidate) for candidate in self.client.search(["ALL"])
                              if int(candidate) not in target_uids_before]
            if not candidates and target_uidnext > 0:
                candidates = [int(candidate) for candidate in self.client.search(
                    ["UID", f"{target_uidnext}:*"]
                ) if int(candidate) >= target_uidnext]
            if len(candidates) == 1:
                target_uid = int(candidates[0])
        if not target_uid:
            raise RuntimeError("服务器已复制邮件，但无法唯一确认目标副本；源邮件未删除，请同步目标文件夹后检查")
        self.select_folder(source_folder)
        if not self.client.search(["UID", str(uid)]):
            raise RuntimeError("复制后源邮件状态发生变化；为避免误删已停止操作")
        self.client.add_flags([uid], ["\\Deleted"], silent=True)
        self.client.expunge([uid])
        return target_uid

    def create_mailbox(self, name: str):
        self.client.create_folder(name)

    def delete_mailbox(self, name: str):
        protected = {value.casefold() for value in (
            config.INBOX_FOLDER, config.QUARANTINE_FOLDER, config.SPAM_FOLDER,
            "INBOX", "Sent", "Sent Items", "Sent Messages", "Drafts", "Trash", "Junk", "Spam",
            "Archive", "Archives", "All Mail", "已发送", "草稿箱", "已删除", "垃圾邮件")}
        folders = self.client.list_folders()
        target = next((item for item in folders if self._text(item[2]) == name), None)
        if not target:
            raise ValueError("文件夹不存在")
        flags, delimiter, _ = target
        special = {"\\sent", "\\drafts", "\\trash", "\\junk", "\\archive", "\\all", "\\inbox", "\\noselect"}
        if name.casefold() in protected or special.intersection(self._text(flag).lower() for flag in flags):
            raise ValueError("系统文件夹不能删除")
        if delimiter and any(self._text(item[2]).startswith(name + self._text(delimiter)) for item in folders):
            raise ValueError("请先处理子文件夹，不能删除父目录")
        info = self.client.select_folder(name, readonly=True)
        if int(info.get(b"EXISTS", 0)) or self.client.search(["ALL"]):
            raise ValueError("文件夹内仍有邮件，请先移动邮件后再删除")
        self.client.delete_folder(name)

    def fetch_folder(self, folder: str, limit: int = 0, known_uids: set[int] | None = None):
        """分批同步文件夹；已入库 UID 只读取 FLAGS，避免反复下载全部正文。"""
        info = self.select_folder(folder, readonly=True, reset_generation=True)
        if self._uid_validity(info) and db.get_uid_validity(folder) == self._uid_validity(info):
            # A generation reset detached the old identities, so refresh the set.
            known_uids = db.folder_uids(folder)
        uids = sorted(self.client.search(["ALL"]), reverse=True)
        if limit > 0:
            uids = uids[:limit]
        known_uids = {int(uid) for uid in (known_uids or set())}
        for offset in range(0, len(uids), 50):
            batch = uids[offset:offset + 50]
            existing = [uid for uid in batch if int(uid) in known_uids]
            self.client.select_folder(folder, readonly=True)
            flag_data = self.client.fetch(existing, ["FLAGS"]) if existing else {}
            for uid in batch:
                already_local = uid in existing
                if already_local:
                    item = flag_data.get(uid, {})
                else:
                    self.client.select_folder(folder, readonly=True)
                    item = self.client.fetch([uid], ["BODY.PEEK[]", "FLAGS"]).get(uid, {})
                raw = None if already_local else item.get(b"BODY[]")
                flags = [self._text(flag) for flag in item.get(b"FLAGS", [])]
                # raw=None means the local copy is current and only flags changed.
                if already_local or raw is not None:
                    yield uid, raw, flags

    def fetch_new(self, limit: int | None = None):
        """返回有长度的惰性邮件序列，按 UID 升序；首次只取最近 limit 封。"""
        self.select_folder(config.INBOX_FOLDER, readonly=True, reset_generation=True)
        last = db.get_last_uid(config.INBOX_FOLDER)
        if last:
            uids = self.client.search(["UID", f"{last + 1}:*"])
            uids = [u for u in uids if u > last]  # 部分服务器对越界 UID 区间会返回最后一封
        else:
            uids = self.client.search(["ALL"])
            if limit:
                uids = uids[-limit:]
        if not uids:
            return []
        return RawMessageBatch(self.client, config.INBOX_FOLDER, sorted(uids))

    def fetch_older(self, before_uid: int, limit: int = 20):
        """拉取早于 before_uid 的邮件，按 UID 降序取 limit 封。"""
        self.select_folder(config.INBOX_FOLDER, readonly=True, reset_generation=True)
        uids = self.client.search(["UID", f"1:{before_uid - 1}"])
        uids = [u for u in uids if u < before_uid]
        if not uids:
            return []
        uids = sorted(uids, reverse=True)[:limit]
        return RawMessageBatch(self.client, config.INBOX_FOLDER, sorted(uids))

    def move_to(self, uid: int, folder: str):
        """移动邮件到指定文件夹（优先 MOVE 扩展，不支持则 copy+delete）。"""
        return self.move(uid, config.INBOX_FOLDER, folder)
