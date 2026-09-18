"""统计看板、日报与周报。"""
import json
import logging
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException

from ... import config, db, pipeline
from ..helpers import campaign_groups

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/stats")
def api_stats(days: int = 7):
    """兼容旧接口，返回扩展指标。"""
    return db.stats_range(days)


@router.get("/api/dashboard")
def api_dashboard(days: int = 7):
    stats = db.stats_range(days)
    operations = db.dashboard_operations(days)
    evaluation = None
    report_path = os.path.join(config.DATA_DIR, "evaluation_latest.json")
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            evaluation = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    return {
        **stats,
        "trend": db.daily_trend(days),
        "top_senders": db.sender_risk_top(5),
        "todos_open": db.list_todos(include_done=False).__len__(),
        "evaluation": evaluation,
        "operations": operations,
        "action_policy": pipeline.get_action_policy(),
        "campaigns": campaign_groups(days),
    }


@router.get("/api/digest")
def api_digest():
    text = pipeline.today_digest()
    if not text:
        raise HTTPException(503, "LLM 未配置或今天没有可分析的邮件")
    # 保存日报历史，同一天多次生成则保留最新一次（先删后插）
    today = datetime.now().strftime("%Y-%m-%d")
    with db.conn() as c:
        c.execute("DELETE FROM digest_history WHERE digest_date=?", (today,))
    db.save_digest(text, today)
    return {"digest": text}


@router.get("/api/digests")
def api_digests(limit: int = 30):
    return db.list_digests(limit)


@router.get("/api/digests/{digest_id}")
def api_digest_detail(digest_id: int):
    row = db.get_digest(digest_id)
    if not row:
        raise HTTPException(404, "日报不存在")
    return row


@router.get("/api/weekly_report")
def api_weekly_report():
    stats = db.stats_range(days=7)
    lines = [
        "## 本周邮件安全周报",
        f"- 总处理邮件：**{stats['total']}** 封",
        f"- 钓鱼邮件：**{stats['phishing']}** 封",
        f"- 可疑邮件：**{stats['suspicious']}** 封",
        f"- 垃圾邮件：**{stats['spam']}** 封",
        f"- 已隔离：**{stats['quarantine']}** 封",
        f"- 误报：**{stats['false_positives']}** 封",
        f"- 漏报：**{stats['false_negatives']}** 封",
        f"- 估算节省人工审核时间：**{stats['saved_hours']}** 小时",
    ]
    top = db.sender_risk_top(5)
    if top:
        lines.append("\n### 高风险发件人 TOP5")
        for p in top:
            lines.append(f"- {p['sender_key']}（风险分 {p['risk_score']}，邮件数 {p['message_count']}）")
    return {"report": "\n".join(lines)}
