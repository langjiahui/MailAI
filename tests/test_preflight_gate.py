"""仅高风险发信问题需要一次清晰确认。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    source = (ROOT / "app/web/static/app.js").read_text(encoding="utf-8")
    styles = (ROOT / "app/web/static/style.css").read_text(encoding="utf-8")
    start = source.index("document.getElementById('btn-send-mail').addEventListener")
    end = source.index("document.getElementById('btn-compose-ai')", start)
    send_flow = source[start:end]
    assert "window.confirm" not in send_flow
    assert "if (preflight.blockingIssues.length)" in send_flow
    assert "compose-preflight-ack" not in send_flow
    assert "data-preflight-send" in send_flow
    assert "composePreflightFingerprint" in send_flow
    assert send_flow.index("if (preflight.blockingIssues.length)") < send_flow.index("submitComposeMail(payload, false)")
    assert "filter(item => item.level === 'danger')" in source
    assert "scrollIntoView" not in send_flow
    assert ".compose-card { overflow: hidden; }" in styles
    assert ".compose-editor { flex: 1 1 0; min-height: 0;" in styles
    assert 'class="preflight-backdrop"' in source
    assert 'class="preflight-dialog" role="dialog" aria-modal="true"' in source
    assert ".compose-preflight { position:absolute; inset:0; z-index:35;" in styles
    assert ".preflight-list { min-height:0;" in styles
    assert ".preflight-decision { display:flex; flex:0 0 auto;" in styles
    print("✅ 高风险发送确认门禁通过")


if __name__ == "__main__":
    main()
