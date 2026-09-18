"""反馈分析：汇总用户对检测结果的误报(fp)/漏报(fn)反馈，给出处置建议。

默认分析当前账号库（config.DB_PATH），可用 --db 指定其他库文件。

用法:
  python scripts/analyze_feedback.py [--db 路径] [--days 90] [--json]
"""
import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db


def analyze(days: int = 90) -> dict:
    cutoff = (datetime.now() - timedelta(days=max(1, days))).isoformat(timespec="seconds")
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,subject,from_addr,date,verdict,score,feedback,feedback_note,findings,urls,attachments "
            "FROM emails WHERE feedback IN ('fp','fn') AND COALESCE(date,'') >= ? "
            "ORDER BY date DESC", (cutoff,)).fetchall()]

    fp_rows = [r for r in rows if r["feedback"] == "fp"]
    fn_rows = [r for r in rows if r["feedback"] == "fn"]

    def domain_of(addr):
        return (addr or "").lower().rsplit("@", 1)[-1]

    def rule_codes(row):
        try:
            findings = json.loads(row.get("findings") or "[]")
        except (TypeError, json.JSONDecodeError):
            return []
        return [f.get("code", "") for f in findings if isinstance(f, dict)]

    fp_domains = Counter(domain_of(r["from_addr"]) for r in fp_rows)
    fp_rules = Counter(code for r in fp_rows for code in rule_codes(r))
    fn_domains = Counter(domain_of(r["from_addr"]) for r in fn_rows)

    def samples(items):
        return [{
            "id": r["id"], "subject": r.get("subject") or "",
            "from_addr": r.get("from_addr") or "", "date": r.get("date") or "",
            "verdict": r.get("verdict") or "", "score": r.get("score") or 0,
            "note": r.get("feedback_note") or "",
        } for r in items[:10]]

    suggestions = []
    for domain, count in fp_domains.most_common():
        if domain and count >= 2:
            suggestions.append(
                f"域名 {domain} 有 {count} 次误报反馈，核实后可加入白名单或可信发件人")
    for code, count in fp_rules.most_common():
        if code and count >= 3:
            suggestions.append(
                f"规则 {code} 出现在 {count} 次误报中，建议在规则中心检查其权重或适用范围")
    for domain, count in fn_domains.most_common():
        if domain and count >= 2:
            suggestions.append(
                f"域名 {domain} 有 {count} 次漏报反馈，建议检查其典型话术并考虑加入黑名单")

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "window_days": days,
        "totals": {"fp": len(fp_rows), "fn": len(fn_rows)},
        "fp": {
            "by_domain": fp_domains.most_common(),
            "by_rule": fp_rules.most_common(),
            "samples": samples(fp_rows),
        },
        "fn": {
            "by_domain": fn_domains.most_common(),
            "samples": samples(fn_rows),
        },
        "suggestions": suggestions,
    }


def _print_text(report: dict) -> None:
    t = report["totals"]
    print(f"反馈分析（近 {report['window_days']} 天）: 误报 {t['fp']} 条，漏报 {t['fn']} 条")
    if report["fp"]["by_domain"]:
        print("\n误报 Top 发件域:")
        for domain, count in report["fp"]["by_domain"][:5]:
            print(f"  {domain or '(未知)'}: {count} 次")
    if report["fp"]["by_rule"]:
        print("\n误报涉及规则:")
        for code, count in report["fp"]["by_rule"][:5]:
            print(f"  {code}: {count} 次")
    if report["fn"]["by_domain"]:
        print("\n漏报 Top 发件域:")
        for domain, count in report["fn"]["by_domain"][:5]:
            print(f"  {domain or '(未知)'}: {count} 次")
    if report["suggestions"]:
        print("\n处置建议:")
        for s in report["suggestions"]:
            print(f"  - {s}")
    if not (t["fp"] or t["fn"]):
        print("窗口内没有用户反馈记录。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", help="账号库路径（默认当前账号）")
    parser.add_argument("--days", type=int, default=90, help="统计窗口天数（默认 90）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    if args.db:
        if not os.path.exists(args.db):
            print(f"库文件不存在: {args.db}")
            return 2
        config.DB_PATH = args.db

    report = analyze(days=args.days)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_text(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
