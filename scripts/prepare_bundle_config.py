"""从本机 .env 生成安装包企业默认配置，不携带任何邮箱账号。"""
from pathlib import Path
import argparse
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent

# 安装包永不携带模型密钥；每位用户在首次使用时自行配置。
allowed = {
    "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT", "LLM_DIGEST_TIMEOUT",
    "LLM_DIGEST_MAX_TOKENS", "LLM_VERIFY_SSL", "LLM_ANALYZE_ALL", "LLM_MAX_BODY_CHARS",
    "LLM_EXTRA_PARAMS", "REDACT_BEFORE_LLM", "MULTIMODAL_ENABLED", "MULTIMODAL_MODEL",
    "MULTIMODAL_MAX_IMAGES", "MULTIMODAL_MAX_IMAGE_BYTES", "COMPANY_DOMAIN",
    "TRUSTED_DOMAINS", "TRUSTED_SENDERS", "POLL_INTERVAL_SECONDS", "INITIAL_FETCH_LIMIT",
    "HISTORY_AI_DAYS", "HISTORY_AI_LIMIT",
    "INBOX_FOLDER", "QUARANTINE_FOLDER", "SPAM_FOLDER", "ACTION_MODE",
}

def bundle_values(source):
    values = {key: source[key] for key in sorted(allowed) if source.get(key) is not None}
    # A new installation must not move mail until its owner chooses a policy.
    values['ACTION_MODE'] = 'observe'
    return values


def write_config(target, values):
    # Quote values so spaces, comments, JSON extra parameters and newlines survive.
    def quote(value):
        return "'" + str(value).replace('\\', '\\\\').replace("'", "\\'") + "'"
    target.write_text(''.join(f'{key}={quote(value)}\n' for key, value in values.items()), encoding='utf-8')
    target.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    args = parser.parse_args()
    target = ROOT / 'mailai.defaults.env'
    write_config(target, bundle_values(dotenv_values(ROOT / '.env')))
    print(f'已生成默认配置：{target.name}（不含模型密钥和邮箱账号；首次使用仅观察）')


if __name__ == '__main__':
    main()
