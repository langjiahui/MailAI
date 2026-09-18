"""语料导出：把本地库中的邮件导出为脱敏 .eml + labels.json，用于扩充评估语料。

脱敏策略（遵守"真实样本脱敏且默认不入库"的红线）:
  - 本账号地址与公司域名（COMPANY_DOMAIN）的地址一律改写为 user-<hash>@example.test，
    并丢弃其显示名（同事姓名属于个人信息）;
  - 正文/主题中出现的公司域名与本账号地址同步替换;
  - 外部发件人（含攻击者基础设施）原样保留 —— 那是检测需要学习的特征;
  - 附件原样保留，正文业务内容无法自动识别脱敏。

导出任一邮件前请人工核对内容无敏感信息；输出目录默认在 data/ 下（已被 gitignore），
只有人工确认脱敏到位的样本才允许复制进 tests/datasets/ 并提交。

用法:
  python scripts/export_corpus.py [--db 路径] [--out 目录] [--verdict clean|suspicious|phishing]
                                  [--feedback fp|fn] [--limit 50]
"""
import argparse
import email
import email.policy
import email.utils
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db

_ADDRESS_HEADERS = ("From", "To", "Cc", "Bcc", "Reply-To", "Sender")


def _internal_addresses(msg, own_addr: str, company_domain: str) -> set:
    """收集需要脱敏的地址：本账号 + 公司域。"""
    internal = set()
    for header in _ADDRESS_HEADERS:
        for _name, addr in email.utils.getaddresses(msg.get_all(header, [])):
            addr = (addr or "").lower()
            if not addr:
                continue
            domain = addr.rsplit("@", 1)[-1]
            if addr == own_addr or (company_domain and domain == company_domain):
                internal.add(addr)
    return internal


def _alias(addr: str) -> str:
    digest = hashlib.sha1(addr.encode("utf-8")).hexdigest()[:8]
    return f"user-{digest}@example.test"


def _desensitize(raw: bytes, own_addr: str, company_domain: str) -> bytes:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    internal = _internal_addresses(msg, own_addr, company_domain)
    replacements = {addr: _alias(addr) for addr in internal}
    if company_domain:
        replacements[company_domain] = "example.test"
    if own_addr:
        replacements.setdefault(own_addr, _alias(own_addr))

    for header in _ADDRESS_HEADERS:
        if header not in msg:
            continue
        values = msg.get_all(header, [])
        del msg[header]
        rewritten = []
        for name, addr in email.utils.getaddresses(values):
            addr_l = (addr or "").lower()
            if addr_l in internal:
                rewritten.append(_alias(addr_l))  # 内部地址：丢显示名
            else:
                rewritten.append(email.utils.formataddr((name, addr)) if name else addr)
        if rewritten:
            msg[header] = ", ".join(rewritten)

    if msg["Subject"]:
        subject = str(msg["Subject"])
        for old, new in replacements.items():
            subject = subject.replace(old, new)
        msg.replace_header("Subject", subject)

    for part in msg.walk():
        if part.get_content_maintype() != "text":
            continue
        try:
            text = part.get_content()
        except Exception:
            continue
        for old, new in replacements.items():
            text = text.replace(old, new)
        part.set_content(text)

    msg["X-MailAI-Export"] = "desensitized"
    return msg.as_bytes()


def export(db_path: str | None, out_dir: str, verdict: str = "all",
           feedback: str | None = None, limit: int = 50) -> dict:
    if db_path:
        config.DB_PATH = db_path
    os.makedirs(out_dir, exist_ok=True)

    clauses, params = ["raw_path IS NOT NULL", "raw_path != ''"], []
    if verdict != "all":
        clauses.append("verdict = ?")
        params.append(verdict)
    if feedback:
        clauses.append("feedback = ?")
        params.append(feedback)
    params.append(max(1, limit))
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            f"SELECT id,subject,from_addr,date,verdict,feedback,status,raw_path FROM emails "
            f"WHERE {' AND '.join(clauses)} ORDER BY date DESC LIMIT ?", params).fetchall()]

    own_addr = (config.IMAP_USER or "").lower()
    company_domain = (config.COMPANY_DOMAIN or "").lower()
    labels, exported, skipped = {}, [], []
    for row in rows:
        raw_path = row["raw_path"]
        if not os.path.exists(raw_path):
            skipped.append({"id": row["id"], "reason": "raw 文件缺失"})
            continue
        with open(raw_path, "rb") as f:
            raw = f.read()
        try:
            clean = _desensitize(raw, own_addr, company_domain)
        except Exception as e:
            skipped.append({"id": row["id"], "reason": f"解析失败: {e}"})
            continue
        label = row["verdict"] or "clean"
        name = f"{label}_{row['id']:05d}.eml"
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(clean)
        labels[name] = "phishing" if label == "phishing" else ("spam" if row.get("status") == "spam" else label)
        exported.append(name)

    labels_path = os.path.join(out_dir, "labels.json")
    existing = {}
    if os.path.exists(labels_path):
        with open(labels_path, "r", encoding="utf-8") as f:
            existing = json.load(f)
    existing.update(labels)
    with open(labels_path, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)

    return {
        "out_dir": out_dir,
        "exported": len(exported),
        "skipped": skipped,
        "labels": labels,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", help="账号库路径（默认当前账号）")
    parser.add_argument("--out", default=os.path.join("data", "corpus_export"),
                        help="输出目录（默认 data/corpus_export，已被 gitignore）")
    parser.add_argument("--verdict", default="all",
                        choices=["all", "clean", "suspicious", "phishing"])
    parser.add_argument("--feedback", choices=["fp", "fn"], help="只导出有误报/漏报反馈的")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    result = export(args.db, args.out, args.verdict, args.feedback, args.limit)
    print(f"已导出 {result['exported']} 封脱敏样本到 {result['out_dir']}")
    for item in result["skipped"]:
        print(f"  跳过 id={item['id']}: {item['reason']}")
    if result["exported"]:
        print("\n⚠️ 请务必人工核对每封邮件无敏感信息后，再复制进 tests/datasets/ 提交。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
