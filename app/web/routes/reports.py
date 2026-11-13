"""统计看板、日报与周报。"""
import json
import logging
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ... import config, db, periodic_briefing, pipeline
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
    # Replace within one transaction so a failed insert cannot erase the saved report.
    today = datetime.now().strftime("%Y-%m-%d")
    db.save_digest(text, today, replace=True)
    return {"digest": text}


@router.get("/api/digest/stream")
def api_digest_stream():
    """流式生成今日日报：NDJSON 逐段下发 delta，完整生成后才覆盖保存当日日报。"""
    from fastapi.responses import StreamingResponse

    def generate():
        parts = []
        try:
            for delta in pipeline.today_digest_stream():
                parts.append(delta)
                yield json.dumps({"type": "delta", "content": delta}, ensure_ascii=False) + "\n"
        except Exception:
            log.exception("日报流式生成失败")
            yield json.dumps({"type": "error", "message": "生成中断，已生成的内容保留，可点击刷新重试"}, ensure_ascii=False) + "\n"
            return
        text = "".join(parts).strip()
        if not text:
            yield json.dumps({"type": "error", "message": "LLM 未配置或今天没有可分析的邮件"}, ensure_ascii=False) + "\n"
            return
        # 完整生成后才落库：同一天多次生成保留最新一次（先删后插）
        today = datetime.now().strftime("%Y-%m-%d")
        try:
            db.save_digest(text, today, replace=True)
        except Exception:
            log.exception("日报保存失败，保留原日报")
            yield json.dumps({"type": "error", "message": "日报保存失败，请点击刷新重试；原有日报仍保留"}, ensure_ascii=False) + "\n"
            return
        yield json.dumps({"type": "done", "digest": text}, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


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


class PeriodicBriefingRequest(BaseModel):
    period: str = Field("this_week", max_length=30)
    start_date: str = Field("", max_length=20)
    end_date: str = Field("", max_length=20)
    style: str = Field("leader", max_length=20)
    focus: str = Field("", max_length=400)
    include_preferences: bool = True
    mode: str = Field("auto", max_length=16)
    save: bool = True


class PeriodicBriefingSaveRequest(BaseModel):
    briefing_id: int | None = Field(None, ge=1)
    period: str = Field("this_week", max_length=30)
    start_date: str = Field("", max_length=20)
    end_date: str = Field("", max_length=20)
    style: str = Field("leader", max_length=20)
    title: str = Field("", max_length=200)
    content: str = Field(min_length=1, max_length=100000)
    metrics: dict = Field(default_factory=dict)
    source: str = Field("local", max_length=16)


@router.get("/api/work/briefings/preview")
def api_work_briefing_preview(
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    focus: str = "",
    include_preferences: bool = True,
):
    try:
        return periodic_briefing.collect_summary(
            period, start_date, end_date, focus=focus, include_preferences=include_preferences
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/api/work/briefings")
def api_work_briefings(limit: int = 30):
    return periodic_briefing.list_briefings(limit)


@router.get("/api/work/briefings/{briefing_id}")
def api_work_briefing_detail(briefing_id: int):
    item = periodic_briefing.get_briefing(briefing_id)
    if not item:
        raise HTTPException(404, "周期简报不存在")
    return item


@router.post("/api/work/briefings/generate")
def api_work_briefing_generate(payload: PeriodicBriefingRequest):
    try:
        return periodic_briefing.generate_briefing(**payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/api/work/briefings/stream")
def api_work_briefing_stream(payload: PeriodicBriefingRequest):
    try:
        periodic_briefing.resolve_window(payload.period, payload.start_date, payload.end_date)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    def generate():
        try:
            for event in periodic_briefing.stream_briefing(**payload.model_dump()):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except ValueError as exc:
            yield json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False) + "\n"
        except Exception:
            log.exception("周期简报流式生成失败")
            yield json.dumps({"type": "error", "message": "周期简报生成中断，可重试或改用本地汇总"}, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/api/work/briefings")
def api_work_briefing_save(payload: PeriodicBriefingSaveRequest):
    try:
        return periodic_briefing.save_briefing(**payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/api/work/briefings/{briefing_id}")
def api_work_briefing_delete(briefing_id: int):
    if not periodic_briefing.delete_briefing(briefing_id):
        raise HTTPException(404, "周期简报不存在")
    return {"ok": True}
