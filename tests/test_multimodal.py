"""多模态图片附件请求与风险证据映射测试（不调用真实模型）。"""
import json
import os
import sys
import tempfile
from email.message import EmailMessage

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import parser
from app.llm import client, multimodal


def main():
    msg = EmailMessage()
    msg["Subject"] = "请扫码验证账号"
    msg["From"] = "security@example.test"
    msg["To"] = "user@example.test"
    msg.set_content("请在十分钟内扫码完成账号验证。")
    # 最小 PNG 数据足以验证 base64 data URL 组装；视觉结论由桩响应提供。
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452")
    msg.add_attachment(png, maintype="image", subtype="png", filename="verify.png")

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "sample.eml")
        with open(path, "wb") as f:
            f.write(msg.as_bytes())
        email = parser.parse_message(1, msg.as_bytes(), save_raw=False)
        email["raw_path"] = path

        old_available = client.available
        old_completion = client.chat_completion
        captured = {}
        try:
            client.available = lambda: True

            def fake_completion(messages, **kwargs):
                captured["messages"] = messages
                captured["kwargs"] = kwargs
                payload = {
                    "risk": "phishing", "confidence": 0.91, "qr_present": True,
                    "qr_target": "https://example.test/login", "evidence": ["仿冒登录提示"],
                    "summary": "二维码引导至账号验证页面",
                }
                return {"choices": [{"message": {"content": json.dumps(payload)}}]}

            client.chat_completion = fake_completion
            review = multimodal.analyze_images(email)
            findings = multimodal.to_findings(review)
        finally:
            client.available = old_available
            client.chat_completion = old_completion

    parts = captured["messages"][1]["content"]
    assert any(p.get("type") == "image_url" and p["image_url"]["url"].startswith("data:image/png;base64,") for p in parts)
    assert captured["kwargs"]["model"]
    assert review["risk"] == "phishing"
    assert {f["code"] for f in findings} == {"VISION_SOCIAL_ENGINEERING", "VISION_QR"}
    print("✅ Qwen 多模态图片/二维码复核测试通过")


if __name__ == "__main__":
    main()
