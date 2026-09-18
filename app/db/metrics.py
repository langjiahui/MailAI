"""统计看板与运营指标。"""
from .core import conn


def stats_today():
    with conn() as c:
        def n(where=""):
            return c.execute(
                f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND date(COALESCE(NULLIF(date,''),created_at))="
                f"date('now','localtime') {where}"
            ).fetchone()["n"]
        return {
            "today": n(),
            "quarantine": n("AND status='quarantine'"),
            "suspicious": n("AND verdict='suspicious' AND status='inbox'"),
            "spam": n("AND status='spam'"),
            "todos_open": c.execute(
                "SELECT COUNT(*) AS n FROM todos WHERE status='open'"
            ).fetchone()["n"],
        }


def stats_range(days: int = 7):
    with conn() as c:
        def n(where=""):
            return c.execute(
                f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND "
                f"datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?) {where}",
                (f"-{days} days",),
            ).fetchone()["n"]

        total = n()
        phishing = n("AND verdict='phishing'")
        suspicious = n("AND verdict='suspicious'")
        spam = n("AND verdict='clean' AND status='spam'")
        quarantine = n("AND status='quarantine'")
        clean = n("AND verdict='clean' AND status='inbox'")
        false_positives = n("AND feedback='fp'")
        false_negatives = n("AND feedback='fn'")

        avg_handle = c.execute(
            "SELECT AVG((julianday(created_at) - julianday(date)) * 86400) AS v "
            "FROM emails WHERE created_at >= datetime('now','localtime', ?) AND date IS NOT NULL",
            (f"-{days} days",),
        ).fetchone()["v"] or 0

        return {
            "total": total,
            "phishing": phishing,
            "suspicious": suspicious,
            "spam": spam,
            "quarantine": quarantine,
            "clean": clean,
            "false_positives": false_positives,
            "false_negatives": false_negatives,
            "avg_handle_seconds": round(avg_handle, 2),
            "saved_hours": round((phishing + spam) * 3 / 60, 2),
        }


def daily_trend(days: int = 7):
    with conn() as c:
        rows = c.execute(
            "SELECT date(COALESCE(NULLIF(date,''),created_at)) AS d, verdict, COUNT(*) AS n "
            "FROM emails WHERE remote_missing=0 AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?) "
            "GROUP BY date(COALESCE(NULLIF(date,''),created_at)), verdict",
            (f"-{days} days",),
        ).fetchall()
    trend = {}
    for r in rows:
        trend.setdefault(r["d"], {})[r["verdict"] or "clean"] = r["n"]
    return trend


def dashboard_operations(days: int = 7):
    """Return decision-oriented security operations data for the dashboard."""
    days = max(1, min(int(days), 90))
    current_window = f"-{days} days"
    previous_window = f"-{days * 2} days"
    risk_where = "verdict IN ('phishing','suspicious')"
    with conn() as c:
        def scalar(sql, args=()):
            row = c.execute(sql, args).fetchone()
            return int(row["n"] or 0)

        dated = "datetime(COALESCE(NULLIF(date,''),created_at))"
        current_total = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        current_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        previous_total = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {dated} >= datetime('now','localtime', ?) AND {dated} < datetime('now','localtime', ?)",
            (previous_window, current_window),
        )
        previous_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?) AND {dated} < datetime('now','localtime', ?)",
            (previous_window, current_window),
        )
        pending_review = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            "AND reviewed=0 AND COALESCE(feedback,'')=''"
        )
        pending_period = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND reviewed=0 AND COALESCE(feedback,'')='' AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        auto_handled = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND action_taken=1 AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        resolved_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND (reviewed=1 OR COALESCE(feedback,'')<>'') AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        feedback_count = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND COALESCE(feedback,'')<>'' AND {dated} >= datetime('now','localtime', ?)",
            (current_window,),
        )
        today_risk = scalar(
            f"SELECT COUNT(*) AS n FROM emails WHERE remote_missing=0 AND {risk_where} "
            f"AND date(COALESCE(NULLIF(date,''),created_at))=date('now','localtime')"
        )
        attention = [dict(r) for r in c.execute(
            "SELECT id,subject,from_addr,from_name,date,created_at,score,verdict,status,action_taken "
            f"FROM emails WHERE remote_missing=0 AND {risk_where} AND reviewed=0 AND COALESCE(feedback,'')='' "
            "ORDER BY score DESC, datetime(COALESCE(NULLIF(date,''),created_at)) DESC LIMIT 6"
        ).fetchall()]
        risky_senders = [dict(r) for r in c.execute(
            "SELECT lower(COALESCE(NULLIF(from_addr,''),'未知发件人')) AS sender, MAX(id) AS email_id, COUNT(*) AS risk_count, "
            "MAX(score) AS max_score, SUM(CASE WHEN verdict='phishing' THEN 1 ELSE 0 END) AS phishing_count "
            f"FROM emails WHERE remote_missing=0 AND {risk_where} AND {dated} >= datetime('now','localtime', ?) "
            "GROUP BY lower(COALESCE(NULLIF(from_addr,''),'未知发件人')) "
            "ORDER BY risk_count DESC, max_score DESC LIMIT 5",
            (current_window,),
        ).fetchall()]

    current_rate = current_risk * 100 / current_total if current_total else 0.0
    previous_rate = previous_risk * 100 / previous_total if previous_total else 0.0
    return {
        "pending_review": pending_review,
        "pending_period": pending_period,
        "today_risk": today_risk,
        "risk_count": current_risk,
        "risk_rate": round(current_rate, 1),
        "risk_rate_delta": round(current_rate - previous_rate, 1),
        "auto_handled": auto_handled,
        "resolved_risk": resolved_risk,
        "feedback_count": feedback_count,
        "attention": attention,
        "risky_senders": risky_senders,
    }
