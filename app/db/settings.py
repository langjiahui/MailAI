"""规则开关、运行时设置与安全白名单。"""
from datetime import datetime

from .core import conn


def list_rule_settings():
    with conn() as c:
        return {r["code"]: dict(r) for r in c.execute("SELECT * FROM rule_settings").fetchall()}


def set_rule_setting(code: str, enabled: bool, weight: int):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO rule_settings(code,enabled,weight,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,weight=excluded.weight,updated_at=excluded.updated_at",
            (code, 1 if enabled else 0, weight, now),
        )


def delete_rule_settings():
    with conn() as c:
        c.execute("DELETE FROM rule_settings")


def list_security_allowlist():
    with conn() as c:
        domains = [dict(r) | {"kind": "domain", "value": r["domain"]} for r in c.execute(
            "SELECT id,domain,enabled,note,created_at,updated_at "
            "FROM security_allowlist ORDER BY enabled DESC, domain ASC"
        ).fetchall()]
        addresses = [dict(r) | {"kind": "address", "value": r["email"]} for r in c.execute(
            "SELECT id,email,enabled,note,created_at,updated_at "
            "FROM security_allowlist_addresses ORDER BY enabled DESC, email ASC"
        ).fetchall()]
        return sorted(domains + addresses, key=lambda item: (not bool(item["enabled"]), item["value"]))


def upsert_security_allowlist(domain: str, enabled: bool = True, note: str = ""):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO security_allowlist(domain,enabled,note,created_at,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(domain) DO UPDATE SET enabled=excluded.enabled,note=excluded.note,updated_at=excluded.updated_at",
            (domain, 1 if enabled else 0, note, now, now),
        )
        row = c.execute("SELECT * FROM security_allowlist WHERE domain=?", (domain,)).fetchone()
        return dict(row)


def delete_security_allowlist(entry_id: int) -> bool:
    with conn() as c:
        cursor = c.execute("DELETE FROM security_allowlist WHERE id=?", (entry_id,))
        return cursor.rowcount > 0


def upsert_security_allowlist_address(email: str, enabled: bool = True, note: str = "", connection=None):
    now = datetime.now().isoformat(timespec="seconds")
    def write(c):
        c.execute(
            "INSERT INTO security_allowlist_addresses(email,enabled,note,created_at,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(email) DO UPDATE SET enabled=excluded.enabled,note=excluded.note,updated_at=excluded.updated_at",
            (email, 1 if enabled else 0, note, now, now),
        )
        row = c.execute("SELECT * FROM security_allowlist_addresses WHERE email=?", (email,)).fetchone()
        return dict(row) | {"kind": "address", "value": row["email"]}
    if connection is not None:
        return write(connection)
    with conn() as c:
        return write(c)


def delete_security_allowlist_address(entry_id: int) -> bool:
    with conn() as c:
        cursor = c.execute("DELETE FROM security_allowlist_addresses WHERE id=?", (entry_id,))
        return cursor.rowcount > 0


def set_rule_settings(items: list[tuple[str, bool, int]]):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.executemany(
            "INSERT INTO rule_settings(code,enabled,weight,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,weight=excluded.weight,updated_at=excluded.updated_at",
            [(code, 1 if enabled else 0, weight, now) for code, enabled, weight in items],
        )


def get_runtime_settings():
    with conn() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key,value FROM runtime_settings").fetchall()}


def set_runtime_setting(key: str, value: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO runtime_settings(key,value,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            (key, value, now),
        )
