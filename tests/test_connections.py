"""连通性测试：验证 IMAP 登录和 LLM 接口可用，不处理邮件、不改邮箱状态。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config
from app.imap_client import MailClient
from app.llm import client as llm_client


def test_imap():
    print(f"[IMAP] 连接 {config.IMAP_HOST}:{config.IMAP_PORT} ...")
    try:
        with MailClient() as mail:
            folders = mail.client.list_folders()
            names = [str(f[-1]) for f in folders]
            print(f"[IMAP] 登录成功，共 {len(names)} 个文件夹")
            print("       文件夹示例:", ", ".join(names[:5]))
            mail.client.select_folder(config.INBOX_FOLDER)
            uid_next = mail.client.folder_status(config.INBOX_FOLDER, [b"UIDNEXT"])
            print(f"[IMAP] 收件箱 UIDNEXT: {uid_next}")
            return True
    except Exception as e:
        print(f"[IMAP] 失败: {e}")
        return False


def test_llm():
    print(f"[LLM] 连接 {config.LLM_BASE_URL} 模型 {config.LLM_MODEL} ...")
    if not llm_client.available():
        print("[LLM] 未配置 API Key，跳过")
        return None
    try:
        resp = llm_client.chat_completion(
            messages=[
                {"role": "system", "content": "你是一个邮件安全分析助手。"},
                {"role": "user", "content": "请用 JSON 回复 {'status':'ok'}，不要其它内容。"},
            ],
            temperature=0,
        )
        content = resp.get("choices", [{}])[0].get("message", {}).get("content") or ""
        print(f"[LLM] 调用成功，返回: {content[:100]}")
        return True
    except Exception as e:
        print(f"[LLM] 失败: {e}")
        return False


if __name__ == "__main__":
    ok_imap = test_imap()
    ok_llm = test_llm()
    if ok_imap and ok_llm:
        print("\n✅ IMAP 与 LLM 均连通，可以启动 run.py")
    elif ok_imap:
        print("\n⚠️ IMAP 通，但 LLM 未通，请检查 .env 里的 LLM 配置")
    else:
        print("\n❌ IMAP 未通，请确认密码/授权码、IMAP 是否已开启")
