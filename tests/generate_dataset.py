"""生成测试数据集：合成正常/钓鱼/垃圾邮件 .eml 样本。"""
import os
import json
from email.message import EmailMessage
from email.utils import formatdate

OUT_DIR = os.path.join(os.path.dirname(__file__), "datasets")
os.makedirs(OUT_DIR, exist_ok=True)


def make_email(subject, from_addr, body, to_addr="user@example.com", from_name="",
               reply_to=None, urls=None, html_body=None, list_unsubscribe=None,
               precedence=None):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = to_addr
    msg["Date"] = formatdate()
    msg["Message-ID"] = f"<test-{hash(subject) % 100000000}@example.com>"
    if reply_to:
        msg["Reply-To"] = reply_to
    if list_unsubscribe:
        msg["List-Unsubscribe"] = list_unsubscribe
    if precedence:
        msg["Precedence"] = precedence
    if html_body:
        msg.add_alternative(html_body, subtype="html")
        msg.add_alternative(body, subtype="plain")
    else:
        msg.set_content(body)
    return msg.as_bytes()


def save(name, data, label):
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as f:
        f.write(data)
    return name, label


def main():
    labels = {}

    # 正常邮件
    samples = [
        save("clean_01_project_update.eml", make_email(
            subject="项目周报 - 智能办公平台",
            from_addr="pm01@example.com",
            from_name="项目经理 张工",
            body="各位同事，\n\n本周智能办公平台项目进展如下：\n1. 完成需求评审\n2. 后端接口开发 80%\n3. 下周计划联调\n\n如有问题请随时沟通。",
        ), "clean"),
        save("clean_02_meeting_invite.eml", make_email(
            subject="会议邀请：月度安全例会",
            from_addr="assistant@example.com",
            from_name="行政助理",
            body="您好，\n\n定于本周五 14:00 在 A301 召开月度安全例会，请准时参加。\n\n会议议程见附件。",
        ), "clean"),
        save("clean_03_system_notice.eml", make_email(
            subject="【系统通知】VPN 维护公告",
            from_addr="itsupport@example.com",
            from_name="IT 服务台",
            body="各位同事，\n\n本周六 00:00-06:00 将进行 VPN 设备维护，期间无法远程接入，请提前安排工作。",
        ), "clean"),
    ]

    # 钓鱼邮件
    samples += [
        save("phish_01_spoof_leader.eml", make_email(
            subject="紧急：关于 2026 年度绩效调整",
            from_addr="director@examp1e.com",
            from_name="王总监",
            reply_to="hacker@evil.com",
            body="小王，\n\n这是今年的绩效调整名单，请尽快点击链接确认：\nhttp://bit.ly/3xPj9kL\n\n此事紧急，限今天处理。",
            html_body='<p>小王，</p><p>请<a href="http://bit.ly/3xPj9kL">点击此处</a>查看绩效调整名单。</p>',
        ), "phishing"),
        save("phish_02_account_expired.eml", make_email(
            subject="【账号异常】您的企业邮箱密码即将过期",
            from_addr="noreply@examp1e.com",
            from_name="企业邮箱安全中心",
            body="尊敬的用户：\n\n检测到您的账号存在异常登录，请在 24 小时内点击下方链接验证身份并输入密码修改：\nhttps://login-example.verify-account.test/reset\n\n逾期未处理将冻结账号。",
        ), "phishing"),
        save("phish_03_macro_attachment.eml", make_email(
            subject="发票确认单",
            from_addr="invoice@examp1e.com",
            from_name="财务共享中心",
            body="您好，\n\n附件为贵部门本月发票汇总，请打开后启用宏进行核对。\n\n如有疑问请联系财务部。",
        ), "phishing"),
        save("phish_04_multi_turn.eml", make_email(
            subject="Re: Re: 关于合同审批",
            from_addr="partner@examp1e.com",
            from_name="合作方 李经理",
            body="方总好，\n\n合同已经按上次沟通修改，烦请尽快在附件链接中确认盖章并提供短信验证码：\nhttp://contract-example.test/s/abc123\n\n谢谢！",
        ), "phishing"),
    ]

    # 垃圾邮件
    samples += [
        save("spam_01_marketing.eml", make_email(
            subject="企业级云办公解决方案",
            from_addr="sales@cloud-office-promo.com",
            from_name="云办公促销",
            body="亲爱的客户：\n\n本月促销！购买企业级云办公方案享 5 折，还送优惠券与 1 年运维服务。\n\n点击退订：http://unsubscribe.example.com",
            list_unsubscribe="<http://unsubscribe.example.com>",
            precedence="bulk",
        ), "spam"),
        save("spam_02_training.eml", make_email(
            subject="免费 AI 大模型培训课程",
            from_addr="training@ai-course-sale.com",
            from_name="AI 培训推广",
            body="免费领取 AI 大模型课程！扫码进群了解团购优惠详情。\n\n优惠码：SAVE50",
            list_unsubscribe="<http://unsubscribe.example.com>",
            precedence="bulk",
        ), "spam"),
    ]

    for name, label in samples:
        labels[name] = label

    with open(os.path.join(OUT_DIR, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, indent=2)

    print(f"已生成 {len(samples)} 个测试样本到 {OUT_DIR}")


if __name__ == "__main__":
    main()
