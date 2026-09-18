"""通讯录：个人联系人、往来历史学习、显示名解析与分组。"""
import json
from datetime import datetime
from email.utils import getaddresses

from .. import config
from .core import conn, _columns_of


_recipient_header_name_cache: dict[tuple, dict[str, str]] = {}


def _contact_name_is_placeholder(name: str, address: str) -> bool:
    """Return true for aliases that merely repeat the email or its local part."""
    value = str(name or "").strip(' \t\r\n"').casefold()
    normalized_address = str(address or "").strip().casefold()
    local_part = normalized_address.partition("@")[0]
    return not value or "@" in value or value in {normalized_address, local_part}


def _recipient_header_display_names(c) -> dict[str, str]:
    """Build a revision-scoped address book from locally stored RFC822 headers."""
    database_path = next((row[2] for row in c.execute("PRAGMA database_list") if row[1] == "main"), config.DB_PATH)
    revision = c.execute(
        "SELECT COUNT(*),COALESCE(MAX(id),0),(SELECT value FROM mailbox_sequence WHERE id=1) "
        "FROM emails WHERE remote_missing=0"
    ).fetchone()
    key = (database_path, int(revision[0]), int(revision[1]), int(revision[2]))
    cached = _recipient_header_name_cache.get(key)
    if cached is not None:
        return cached
    names: dict[str, str] = {}
    from ..parser import recipient_names_from_raw_path
    names_column = "recipient_names" if "recipient_names" in _columns_of(c, "emails") else "'' AS recipient_names"
    if names_column.startswith("recipient_names"):
        rows = c.execute(
            "SELECT recipient_names,raw_path FROM emails WHERE remote_missing=0 "
            "AND (trim(coalesce(raw_path,''))<>'' OR "
            "trim(coalesce(recipient_names,'')) NOT IN ('','{}','[]')) "
            "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC"
        ).fetchall()
    else:
        rows = c.execute(
            f"SELECT {names_column},raw_path FROM emails WHERE remote_missing=0 "
            "AND trim(coalesce(raw_path,''))<>'' "
            "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC"
        ).fetchall()
    for row in rows:
        try:
            pairs = json.loads(row["recipient_names"] or "{}")
        except (TypeError, json.JSONDecodeError):
            pairs = {}
        if not isinstance(pairs, dict):
            pairs = {}
        if not pairs:
            pairs = recipient_names_from_raw_path(row["raw_path"] or "")
        for address, name in pairs.items():
            address = str(address or "").strip().casefold()
            name = str(name or "").strip()
            if not address or not name:
                continue
            # Prefer a Chinese display name over an older username-like alias.
            if address not in names or (any('\u3400' <= char <= '\u9fff' for char in name)
                                        and not any('\u3400' <= char <= '\u9fff' for char in names[address])):
                names[address] = name[:160]
    _recipient_header_name_cache[key] = names
    while len(_recipient_header_name_cache) > 8:
        _recipient_header_name_cache.pop(next(iter(_recipient_header_name_cache)))
    return names


def contact_display_names(addresses, *, connection=None) -> dict[str, dict]:
    """Resolve exact email addresses to locally learned names without mutating mail."""
    wanted = {
        address.strip().casefold()
        for value in addresses or []
        for _name, address in getaddresses([str(value or "")])
        if address.strip() and "@" in address
    }
    if not wanted:
        return {}
    result: dict[str, dict] = {}
    scores: dict[str, int] = {}

    def useful(name: str, address: str) -> str:
        value = str(name or "").strip(' \t\r\n"')[:160]
        return "" if _contact_name_is_placeholder(value, address) else value

    def remember(address: str, name: str, source: str, base_score: int, *, allow_placeholder: bool = False):
        address = str(address or "").strip().casefold()
        name = str(name or "").strip(' \t\r\n"')[:160] if allow_placeholder else useful(name, address)
        if not name or address not in wanted:
            return
        chinese = any('\u3400' <= char <= '\u9fff' for char in name)
        score = base_score + (30 if chinese else 0)
        if score > scores.get(address, -1):
            scores[address] = score
            result[address] = {"name": name, "source": source}

    def resolve(c):
        for address, name in _recipient_header_display_names(c).items():
            remember(address, name, "header", 30)
        # SQLite builds can have a low placeholder limit, so keep exact lookups bounded.
        values = sorted(wanted)
        for start in range(0, len(values), 400):
            batch = values[start:start + 400]
            marks = ",".join("?" for _ in batch)
            rows = c.execute(
                f"SELECT lower(from_addr) AS email,from_name,date,id FROM emails "
                f"WHERE remote_missing=0 AND lower(from_addr) IN ({marks}) "
                "AND trim(coalesce(from_name,''))<>'' "
                "ORDER BY datetime(COALESCE(NULLIF(date,''),created_at)) DESC,id DESC",
                batch,
            ).fetchall()
            for row in rows:
                address = str(row["email"] or "").casefold()
                remember(address, row["from_name"], "history", 40)
            saved = c.execute(
                f"SELECT lower(email) AS email,name,source,hidden FROM contacts "
                f"WHERE lower(email) IN ({marks})",
                batch,
            ).fetchall()
            for row in saved:
                address = str(row["email"] or "").casefold()
                if row["hidden"]:
                    result.pop(address, None)
                    scores[address] = 1000
                    continue
                manual = row["source"] == "manual"
                remember(address, row["name"], "manual" if manual else "contact",
                         100 if manual else 35, allow_placeholder=manual)

    if connection is not None:
        resolve(connection)
    else:
        with conn() as c:
            resolve(c)
    return result


def search_contacts(query: str = "", limit: int = 20, favorites_only: bool = False, group_name: str = ""):
    """合并个人通讯录和邮件往来历史；个人名称、收藏与隐藏状态优先。"""
    query = (query or "").strip().lower()
    contacts: dict[str, dict] = {}
    with conn() as c:
        rows = c.execute(
            "SELECT from_addr,from_name,to_addr,date,created_at FROM emails "
            "WHERE coalesce(from_addr,'')<>'' OR coalesce(to_addr,'')<>''"
        ).fetchall()
        sent_rows = c.execute(
            "SELECT to_addr,cc_addr,bcc_addr,COALESCE(sent_at,created_at) AS contact_date "
            "FROM sent_messages WHERE status IN ('sent','accepted')"
        ).fetchall()
        saved_rows = c.execute("SELECT * FROM contacts").fetchall()

    def remember(address: str, name: str = "", contact_date: str = ""):
        address = (address or "").strip().lower()
        if not address or "@" not in address or address == (config.IMAP_USER or "").strip().lower():
            return
        item = contacts.setdefault(address, {
            "id": None, "email": address, "name": "", "company": "", "note": "",
            "favorite": False, "manual": False, "count": 0, "last_contact": "",
        })
        item["count"] += 1
        if name and not item["name"] and not _contact_name_is_placeholder(name, address):
            item["name"] = name.strip(' "')
        if contact_date and contact_date > item["last_contact"]:
            item["last_contact"] = contact_date

    for row in rows:
        contact_date = row["date"] or row["created_at"] or ""
        remember(row["from_addr"], row["from_name"] or "", contact_date)
        for name, address in getaddresses([row["to_addr"] or ""]):
            remember(address, name, contact_date)
    for row in sent_rows:
        for field in ("to_addr", "cc_addr", "bcc_addr"):
            for name, address in getaddresses([row[field] or ""]):
                remember(address, name, row["contact_date"] or "")

    hidden = set()
    for row in saved_rows:
        address = row["email"].strip().lower()
        if row["hidden"]:
            hidden.add(address)
            continue
        item = contacts.setdefault(address, {
            "id": None, "email": address, "name": "", "company": "", "note": "",
            "favorite": False, "manual": False, "count": 0, "last_contact": "",
        })
        item.update({
            "id": row["id"],
            "name": row["name"] or item["name"],
            "company": row["company"] or "",
            "note": row["note"] or "",
            'group_name': row['group_name'] or '',
            "favorite": bool(row["favorite"]),
            "manual": row["source"] == "manual",
        })
    learned_names = contact_display_names(contacts.keys(), connection=None)
    for address, item in contacts.items():
        if (not item["manual"] or not str(item["name"] or "").strip()) and address in learned_names:
            item["name"] = learned_names[address]["name"]
    values = [item for address, item in contacts.items() if address not in hidden]
    if group_name:
        values = [item for item in values if (not item.get('group_name') if group_name == '__ungrouped__' else item.get('group_name') == group_name)]
    if favorites_only:
        values = [item for item in values if item["favorite"]]
    if query:
        from ..pinyin_search import matches
        values = [item for item in values if matches(query, item['name'], item['email'], item['company'])]
    return sorted(values, key=lambda item: (-int(item["favorite"]), -item["count"], item["email"]))[:max(1, min(limit, 300))]


def save_contact(email: str, name: str = "", company: str = "", note: str = "",
                 favorite: bool = False) -> dict:
    """新增或更新个人联系人；历史学习到的记录会被个人资料覆盖。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,name,company,note,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,?,?,?,?,'manual',0,?,?) ON CONFLICT(email) DO UPDATE SET "
            "name=excluded.name,company=excluded.company,note=excluded.note,favorite=excluded.favorite,"
            "source='manual',hidden=0,updated_at=excluded.updated_at",
            (normalized, name.strip(), company.strip(), note.strip(), int(favorite), now, now),
        )
    return next(item for item in search_contacts(normalized, 10) if item["email"] == normalized)


def set_contact_favorite(email: str, favorite: bool) -> dict:
    """收藏历史联系人时只保存用户选择，不要求手工补齐资料。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,?,'history',0,?,?) ON CONFLICT(email) DO UPDATE SET "
            "favorite=excluded.favorite,hidden=0,updated_at=excluded.updated_at",
            (normalized, int(favorite), now, now),
        )
    return next(item for item in search_contacts(normalized, 10) if item["email"] == normalized)


def hide_contact(email: str):
    """从通讯录候选中隐藏；不删除任何邮件或往来记录。"""
    normalized = (email or "").strip().lower()
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO contacts(email,favorite,source,hidden,created_at,updated_at) "
            "VALUES(?,0,'history',1,?,?) ON CONFLICT(email) DO UPDATE SET "
            "favorite=0,hidden=1,updated_at=excluded.updated_at",
            (normalized, now, now),
        )


def contact_history(addresses: list[str]) -> dict[str, int]:
    """返回联系人在本地来往邮件中的出现次数，供发信前首次联系人提醒使用。"""
    wanted = {str(value).strip().casefold() for value in addresses if "@" in str(value)}
    counts = {value: 0 for value in wanted}
    if not wanted:
        return counts
    like_values = [f"%{value}%" for value in wanted]
    where = " OR ".join(["lower(from_addr)=?"] * len(wanted) + ["lower(to_addr) LIKE ?"] * len(wanted))
    with conn() as c:
        rows = c.execute(
            "SELECT from_addr,to_addr FROM emails WHERE remote_missing=0 "
            f"AND ({where})",
            [*wanted, *like_values],
        ).fetchall()
    for row in rows:
        sender = (row["from_addr"] or "").strip().casefold()
        if sender in counts:
            counts[sender] += 1
        for _, address in getaddresses([row["to_addr"] or ""]):
            normalized = address.strip().casefold()
            if normalized in counts:
                counts[normalized] += 1
    # 刚发出的邮件可能还没有被 IMAP 同步回来，也应计入历史联系人。
    with conn() as c:
        sent_rows = c.execute(
            "SELECT to_addr,cc_addr,bcc_addr FROM sent_messages WHERE status='sent' OR status='accepted'"
        ).fetchall()
    for row in sent_rows:
        for field in ("to_addr", "cc_addr", "bcc_addr"):
            for _, address in getaddresses([row[field] or ""]):
                normalized = address.strip().casefold()
                if normalized in counts:
                    counts[normalized] += 1
    return counts


def list_contact_groups():
    with conn() as c:
        return [dict(row) for row in c.execute("SELECT g.name,COUNT(c.id) AS count FROM contact_groups g LEFT JOIN contacts c ON c.group_name=g.name AND c.hidden=0 GROUP BY g.name ORDER BY g.name")]


def save_contact_group(name, previous=None):
    name = str(name or '').strip()
    if not name or len(name) > 80:
        raise ValueError('分组名称不能为空，且不能超过 80 字')
    with conn() as c:
        if previous is not None and not c.execute('SELECT 1 FROM contact_groups WHERE name=?', (previous,)).fetchone():
            raise ValueError('分组不存在，请刷新后重试')
        if name != previous and c.execute('SELECT 1 FROM contact_groups WHERE name=?', (name,)).fetchone():
            raise ValueError('分组名称已存在')
        if previous is None:
            c.execute('INSERT INTO contact_groups(name) VALUES(?)', (name,))
        else:
            c.execute('UPDATE contact_groups SET name=? WHERE name=?', (name, previous))
            c.execute('UPDATE contacts SET group_name=? WHERE group_name=?', (name, previous))
    return {'ok': True, 'name': name}


def delete_contact_group(name):
    with conn() as c:
        c.execute("UPDATE contacts SET group_name='' WHERE group_name=?", (name,))
        c.execute('DELETE FROM contact_groups WHERE name=?', (name,))
    return {'ok': True}


def update_contact_group_members(name, emails, *, remove=False):
    """Change group membership without overwriting personal contact details."""
    addresses = list(dict.fromkeys(str(email).strip().lower() for email in emails))
    if not addresses or len(addresses) > 300:
        raise ValueError('每次请选择 1 至 300 位联系人')
    learned = {}
    if not remove:
        for address in addresses:
            matches = search_contacts(address, 300)
            item = next((item for item in matches if item['email'] == address), None)
            if not item:
                raise ValueError('所选联系人已不存在，请刷新后重新选择')
            learned[address] = item
    now = datetime.now().isoformat(timespec='seconds')
    with conn() as c:
        if not c.execute('SELECT 1 FROM contact_groups WHERE name=?', (name,)).fetchone():
            raise ValueError('分组不存在，请刷新后重试')
        for address in addresses:
            if remove:
                c.execute("UPDATE contacts SET group_name='',updated_at=? WHERE email=? AND group_name=?", (now, address, name))
            else:
                c.execute("INSERT INTO contacts(email,name,group_name,source,created_at,updated_at) VALUES(?,?,?,'history',?,?) ON CONFLICT(email) DO UPDATE SET group_name=excluded.group_name,updated_at=excluded.updated_at",
                          (address, learned[address]['name'], name, now, now))
    return {'ok': True, 'count': len(addresses)}
