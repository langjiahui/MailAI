"""IOC 导出：钓鱼邮件的发件人/域名/IP/URL/附件哈希聚合，JSON 与 CSV。"""
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db
from app.web.routes import security


def _insert_email(uid, sender, verdict, date, attachment_analysis="[]"):
    with db.conn() as c:
        c.execute(
            "INSERT INTO emails(uid,folder,from_addr,subject,date,verdict,attachment_analysis,"
            "created_at,remote_missing) VALUES(?,?,?,?,?,?,?,?,0)",
            (uid, "INBOX", sender, f"样本{uid}", date, verdict, attachment_analysis, date),
        )
        return c.execute("SELECT id FROM emails WHERE uid=?", (uid,)).fetchone()[0]


def main():
    with tempfile.TemporaryDirectory() as root, \
            patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
            patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()
        now = datetime.now().isoformat(timespec="seconds")
        old = (datetime.now() - timedelta(days=200)).isoformat(timespec="seconds")

        phish1 = _insert_email(1, "Attacker@Evil-Example.net", "phishing", now,
                               json.dumps([{"name": "回单.exe", "sha256": "a" * 64}]))
        phish2 = _insert_email(2, "attacker@evil-example.net", "phishing", now,
                               json.dumps([{"name": "回单.exe", "sha256": "a" * 64},
                                           {"name": "发票.docm", "sha256": "b" * 64}]))
        _insert_email(3, "colleague@example.com", "clean", now)
        _insert_email(4, "old@evil-example.net", "phishing", old)  # 超出窗口

        db.save_url_chain(phish1, "http://t.cn/x", [{"url": "http://t.cn/x", "status": 302}],
                          "http://phish-example.net/login", "phish-example.net", "45.1.2.3", "ok")
        db.save_url_chain(phish2, "http://t.cn/x", [{"url": "http://t.cn/x", "status": 302}],
                          "http://phish-example.net/login", "phish-example.net", "45.1.2.3", "ok")
        # 干净邮件的链不应进入 IOC
        db.save_url_chain(_insert_email(5, "news@example.org", "clean", now),
                          "http://t.cn/y", [], "https://example.org/a", "example.org", "", "ok")

        data = security.api_ioc_export()
        # 发件人：大小写归并、只含钓鱼、窗口内
        assert data["senders"] == [
            {"value": "attacker@evil-example.net", "count": 2, "last_seen": now}], data["senders"]
        assert data["sender_domains"] == [
            {"value": "evil-example.net", "count": 2, "last_seen": now}]
        # URL 链：两封钓鱼共用一条链，聚合成一条；干净邮件的链不出现
        assert len(data["urls"]) == 1 and data["urls"][0]["count"] == 2
        assert data["domains"] == [{"value": "phish-example.net", "count": 2, "last_seen": data["domains"][0]["last_seen"]}]
        assert data["ips"] == [{"value": "45.1.2.3", "count": 2, "last_seen": data["ips"][0]["last_seen"]}]
        # 附件哈希：跨邮件聚合，names 合并
        hashes = {h["value"]: h for h in data["attachment_sha256"]}
        assert hashes["a" * 64]["count"] == 2 and hashes["a" * 64]["names"] == ["回单.exe"]
        assert hashes["b" * 64]["count"] == 1

        # 窗口过滤：days=1 时 200 天前的钓鱼邮件不出现（本例它本就不在）
        assert security.api_ioc_export(days=1)["senders"] == data["senders"]

        # CSV 导出
        resp = security.api_ioc_export(format="csv")
        body = resp.body.decode("utf-8") if isinstance(resp.body, bytes) else resp.body
        assert resp.headers["content-disposition"].startswith("attachment")
        lines = [l for l in body.splitlines() if l]
        assert lines[0].endswith("type,value,count,last_seen,extra")
        kinds = {l.split(",", 1)[0].lstrip("﻿") for l in lines[1:]}
        assert {"sender", "sender_domain", "url", "domain", "ip", "attachment_sha256"} <= kinds
        assert any("attacker@evil-example.net" in l for l in lines)
        assert any("45.1.2.3" in l for l in lines)

    print("✅ IOC 导出聚合、窗口过滤与 CSV 测试通过")


if __name__ == "__main__":
    main()
