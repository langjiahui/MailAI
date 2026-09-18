"""离线评估：对 tests/datasets/ 中的样本跑本地检测层，输出指标。

模拟生产管道中不依赖网络/LLM 的部分：规则扫描 + 附件深度分析
（URL 链跟踪需要网络、最终钓鱼裁定由 LLM 复核完成，均不在此列）。
因此钓鱼样本的达标线是"进入复核/隔离"（verdict 为 suspicious 或 phishing），
干净样本必须保持 clean。

`--gate` 模式用于发布/PR 门禁：干净样本误报率 >= 2% 或钓鱼召回率 < 90%
时以非零码退出。每次运行使用全新临时数据库，避免残留旧 schema。

评估必须环境无关：MAILAI_HOME 指向空临时目录，避免拾取本机 .env
（COMPANY_DOMAIN 等配置会显著改变判定结果），DNS 体检打桩为 unknown。
"""
import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime

os.environ["MAILAI_HOME"] = tempfile.mkdtemp(prefix="mailai-eval-home-")

# 把项目根目录加入路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db
from app.parser import parse_message
from app.security import attachments, headers as hdrs, policy, rules

# 评估必须离线且确定性：DNS 体检在断网时会把所有外部域误判为
# "missing"（多扣 15 分），联网与否结果不同。统一打桩为 unknown。
hdrs.dns_profile = lambda domain: {"spf": "unknown", "mx": "unknown", "dmarc": "unknown"}

DATASET_DIR = os.path.join(os.path.dirname(__file__), "datasets")
LABELS_FILE = os.path.join(DATASET_DIR, "labels.json")
REPORT_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "evaluation_latest.json")

# 门禁阈值：干净误报率 < 2%，钓鱼召回率 > 90%
GATE_MAX_CLEAN_FPR = 0.02
GATE_MIN_PHISHING_RECALL = 0.90


def load_samples():
    with open(LABELS_FILE, "r", encoding="utf-8") as f:
        labels = json.load(f)
    samples = []
    for name, label in labels.items():
        path = os.path.join(DATASET_DIR, name)
        with open(path, "rb") as f:
            raw = f.read()
        samples.append({"name": name, "label": label, "raw": raw})
    return samples


def evaluate(gate: bool = False) -> int:
    workdir = tempfile.mkdtemp(prefix="mailai-eval-")
    config.DB_PATH = os.path.join(workdir, "eval.db")
    db.init_db()
    samples = load_samples()
    results = []
    times = []

    for s in samples:
        try:
            email = parse_message(uid=1, raw=s["raw"], save_raw=False)
            # 附件深度分析按 raw_path 提取载荷，给它一个真实落盘文件
            raw_path = os.path.join(workdir, s["name"])
            with open(raw_path, "wb") as f:
                f.write(s["raw"])
            email["raw_path"] = raw_path
            t0 = time.time()
            scan = rules.scan(email)
            # 与 app.pipeline 一致：并入附件深度分析后重新计分/判定
            for r in attachments.analyze_all_attachments(email):
                scan["findings"].extend(r.get("findings", []))
            scan["findings"] = policy.apply(scan["findings"])
            scan["findings"] = policy.apply_allowlist(scan["findings"], scan.get("allowlist"))
            scan["score"] = min(100, sum(f["weight"] for f in scan["findings"]))
            limits = policy.thresholds()
            scan["verdict"] = "phishing" if scan["score"] >= limits["quarantine_score"] else (
                "suspicious" if scan["score"] >= limits["review_score"] else "clean")
            times.append(time.time() - t0)
            results.append({
                "name": s["name"],
                "expected": s["label"],
                "verdict": scan["verdict"],
                "score": scan["score"],
                "spam_score": scan["spam_score"],
            })
        except Exception as e:
            results.append({
                "name": s["name"],
                "expected": s["label"],
                "verdict": "error",
                "score": 0,
                "spam_score": 0,
                "error": str(e),
            })

    # 分类别统计：
    # - phishing：期望进入复核/隔离（verdict 为 suspicious/phishing；最终裁定在生产由 LLM 复核完成）
    # - spam：期望 spam_score >= 25
    # - clean：期望 verdict=clean 且 spam_score < 25
    correct = 0
    clean_total = clean_fp = 0
    phish_total = phish_hit = 0
    spam_total = spam_hit = 0
    errors = []

    for r in results:
        exp = r["expected"]
        act_flagged = r["verdict"] in ("suspicious", "phishing")
        act_spam = r["spam_score"] >= 25
        act_clean = r["verdict"] == "clean" and not act_spam

        if exp == "phishing":
            phish_total += 1
            ok = act_flagged
            phish_hit += 1 if ok else 0
        elif exp == "spam":
            spam_total += 1
            ok = act_spam
            spam_hit += 1 if ok else 0
        else:  # clean
            clean_total += 1
            ok = act_clean
            clean_fp += 0 if ok else 1

        if ok:
            correct += 1
        else:
            errors.append(r)

    total = len(results)
    clean_fpr = clean_fp / clean_total if clean_total else 0.0
    phishing_recall = phish_hit / phish_total if phish_total else 0.0

    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "dataset": "tests/datasets",
        "total": total,
        "accuracy": round(correct / total, 3) if total else 0,
        "clean_fpr": round(clean_fpr, 3),
        "phishing_recall": round(phishing_recall, 3),
        "spam_recall": round(spam_hit / spam_total, 3) if spam_total else None,
        "per_class": {
            "clean": {"total": clean_total, "false_positives": clean_fp},
            "phishing": {"total": phish_total, "detected": phish_hit},
            "spam": {"total": spam_total, "detected": spam_hit},
        },
        "gate": {
            "max_clean_fpr": GATE_MAX_CLEAN_FPR,
            "min_phishing_recall": GATE_MIN_PHISHING_RECALL,
        },
        "avg_process_time_ms": round(sum(times) / len(times) * 1000, 1) if times else 0,
        "errors": errors,
        "samples": results,
    }

    os.makedirs(os.path.dirname(REPORT_FILE), exist_ok=True)
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))

    if gate:
        failures = []
        if clean_fpr >= GATE_MAX_CLEAN_FPR:
            failures.append(
                f"干净误报率 {clean_fpr:.1%} >= 阈值 {GATE_MAX_CLEAN_FPR:.0%}"
            )
        if phishing_recall < GATE_MIN_PHISHING_RECALL:
            failures.append(
                f"钓鱼召回率 {phishing_recall:.1%} < 阈值 {GATE_MIN_PHISHING_RECALL:.0%}"
            )
        if failures:
            print("准确率门禁未通过: " + "; ".join(failures))
            return 2
        print(
            f"准确率门禁通过: 干净误报率 {clean_fpr:.1%} (<{GATE_MAX_CLEAN_FPR:.0%}), "
            f"钓鱼召回率 {phishing_recall:.1%} (>={GATE_MIN_PHISHING_RECALL:.0%})"
        )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate", action="store_true",
                        help="门禁模式：误报/召回超阈值时非零退出")
    args = parser.parse_args()
    raise SystemExit(evaluate(gate=args.gate))
