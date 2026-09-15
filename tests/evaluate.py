"""离线评估：对 tests/datasets/ 中的样本跑规则引擎，输出指标。"""
import json
import os
import sys
import time
from datetime import datetime

# 把项目根目录加入路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db
from app.parser import parse_message
from app.security import rules

# 使用独立临时数据库，避免与运行中的服务冲突
config.DB_PATH = os.path.join(os.path.dirname(__file__), ".eval.db")

DATASET_DIR = os.path.join(os.path.dirname(__file__), "datasets")
LABELS_FILE = os.path.join(DATASET_DIR, "labels.json")
REPORT_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "evaluation_latest.json")


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


def evaluate():
    db.init_db()
    samples = load_samples()
    results = []
    times = []

    for s in samples:
        try:
            email = parse_message(uid=1, raw=s["raw"], save_raw=False)
            t0 = time.time()
            scan = rules.scan(email)
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

    # 评估逻辑
    # - phishing：期望 verdict=phishing
    # - spam：期望 spam_score >= 25（规则会触发 status=spam）
    # - clean：期望 verdict=clean 且 spam_score < 25
    correct = 0
    tp = fp = fn = tn = 0
    errors = []

    for r in results:
        exp = r["expected"]
        act_phishing = r["verdict"] == "phishing"
        act_spam = r["spam_score"] >= 25
        act_clean = r["verdict"] == "clean" and not act_spam

        ok = False
        if exp == "phishing":
            ok = act_phishing
            if act_phishing:
                tp += 1
            else:
                fn += 1
        elif exp == "spam":
            ok = act_spam
            if act_spam:
                tn += 1  # 正确识别为非钓鱼垃圾，计入 TN
            else:
                fn += 1  # 垃圾未被识别，算 FN（漏掉威胁）
        else:  # clean
            ok = act_clean
            if act_clean:
                tn += 1
            elif act_phishing:
                fp += 1
            else:
                fn += 1

        if ok:
            correct += 1
        else:
            errors.append(r)

    total = len(results)
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0

    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "dataset": "tests/datasets",
        "total": total,
        "accuracy": round(correct / total, 2) if total else 0,
        "precision": round(precision, 2),
        "recall": round(recall, 2),
        "f1": round(f1, 2),
        "false_positive_rate": round(fp / (fp + tn), 2) if (fp + tn) else 0,
        "false_negative_rate": round(fn / (fn + tp), 2) if (fn + tp) else 0,
        "avg_process_time_ms": round(sum(times) / len(times) * 1000, 1) if times else 0,
        "errors": errors,
        "samples": results,
    }

    os.makedirs(os.path.dirname(REPORT_FILE), exist_ok=True)
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    evaluate()
