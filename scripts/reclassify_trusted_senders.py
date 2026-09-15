"""按当前规则重算已由业务方确认的固定可信发件人历史邮件。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db, parser
from app.security import rules


def main() -> int:
    if not config.TRUSTED_SENDERS:
        print("未配置 TRUSTED_SENDERS，无需处理")
        return 0
    changed = 0
    with db.conn() as c:
        placeholders = ",".join("?" for _ in config.TRUSTED_SENDERS)
        rows = [dict(r) for r in c.execute(
            f"SELECT * FROM emails WHERE lower(from_addr) IN ({placeholders})",
            tuple(sorted(config.TRUSTED_SENDERS)),
        ).fetchall()]
    for row in rows:
        raw_path = row.get("raw_path")
        if not raw_path or not os.path.exists(raw_path):
            continue
        with open(raw_path, "rb") as f:
            email = parser.parse_message(row["uid"], f.read(), save_raw=False)
        scan = rules.scan(email)
        with db.conn() as c:
            c.execute(
                "UPDATE emails SET score=?, verdict=?, findings=?, auth=?, llm_phishing=NULL, "
                "llm_reasons='[]', review_source='trusted_rule' WHERE id=?",
                (scan["score"], scan["verdict"],
                 json.dumps(scan["findings"] + scan["spam_findings"], ensure_ascii=False),
                 json.dumps(scan["auth"], ensure_ascii=False), row["id"]),
            )
        changed += 1
    db.add_audit_log(None, action="trusted_sender_reclassification", actor="system",
                     reason=f"按业务核验名单重算 {changed} 封历史邮件",
                     meta={"senders": sorted(config.TRUSTED_SENDERS), "changed": changed})
    print(f"已重算 {changed} 封可信发件人历史邮件")
    return changed


if __name__ == "__main__":
    main()
