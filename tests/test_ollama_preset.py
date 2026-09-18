"""Ollama 本地模型预设：免密钥占位、URL 拼接与非白名单回退。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MAILAI_HOME", tempfile.mkdtemp(prefix="mailai-ollama-"))

from app import system_settings
from app.llm.providers import KEYLESS_PLACEHOLDER, KEYLESS_PROVIDERS, PRESETS, completion_url


def main():
    preset = next((p for p in PRESETS if p["id"] == "ollama"), None)
    assert preset, "PRESETS 缺少 ollama"
    assert preset["base_url"] == "http://localhost:11434/v1"
    assert preset["model"], "预设应给出推荐模型"
    assert "ollama" in KEYLESS_PROVIDERS

    # /v1 地址按约定补全 chat completions 路径
    assert completion_url(preset["base_url"]).endswith("/v1/chat/completions")

    # 免密钥：本地服务自动填占位密钥
    resolved = system_settings._model_values({
        "provider": "ollama",
        "base_url": "http://localhost:11434/v1",
        "model": "qwen2.5:7b-instruct",
    })
    assert resolved["api_key"] == KEYLESS_PLACEHOLDER
    assert resolved["provider"] == "ollama"

    # 其他服务商仍然强制要求真实密钥
    try:
        system_settings._model_values({
            "provider": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "model": "deepseek-v4-flash",
        })
        raise AssertionError("非免密钥服务商不应通过")
    except ValueError as e:
        assert "API Key" in str(e)

    # 未知服务商仍被拒绝
    try:
        system_settings._model_values({"provider": "telegram-bot"})
        raise AssertionError("未知服务商不应通过")
    except ValueError:
        pass

    print("✅ Ollama 预设、免密钥占位与服务商校验测试通过")


if __name__ == "__main__":
    main()
