"""生成测试数据集：合成正常/钓鱼/垃圾邮件 .eml 样本。

所有样本均为虚构（example 域 + 合成内容），可安全提交。
改动后运行 `python tests/generate_dataset.py` 重新生成，再用
`python tests/evaluate.py --gate` 验证检测指标没有回退。
"""
import io
import os
import json
import hashlib
import zipfile
from email.message import EmailMessage

OUT_DIR = os.path.join(os.path.dirname(__file__), "datasets")
os.makedirs(OUT_DIR, exist_ok=True)

# 固定日期与确定性 Message-ID：重复生成的输出字节一致，不产生 git 噪音
SAMPLE_DATE = "Mon, 07 Sep 2026 10:00:00 +0800"


def make_email(subject, from_addr, body, to_addr="user@example.com", from_name="",
               reply_to=None, urls=None, html_body=None, list_unsubscribe=None,
               precedence=None, in_reply_to=None, references=None, attachments=None):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = to_addr
    msg["Date"] = SAMPLE_DATE
    digest = hashlib.sha1(subject.encode("utf-8")).hexdigest()[:12]
    msg["Message-ID"] = f"<test-{digest}@example.com>"
    if reply_to:
        msg["Reply-To"] = reply_to
    if list_unsubscribe:
        msg["List-Unsubscribe"] = list_unsubscribe
    if precedence:
        msg["Precedence"] = precedence
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    if html_body:
        msg.add_alternative(html_body, subtype="html")
        msg.add_alternative(body, subtype="plain")
    else:
        msg.set_content(body)
    for filename, content_type, payload in (attachments or []):
        maintype, _, subtype = content_type.partition("/")
        msg.add_attachment(payload, maintype=maintype, subtype=subtype or "octet-stream",
                           filename=filename)
    return msg.as_bytes()


def make_zip(members):
    """构造真实 zip 字节。members: [(文件名, 内容字节), ...]"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members:
            z.writestr(name, data)
    return buf.getvalue()


# 常见合成载荷
PDF_BYTES = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<>>\n%%EOF"
OLE_MACRO_BYTES = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64 + b"_VBA_PROJECT" + b"\x00" * 64
PE_BYTES = b"MZ" + b"\x90" * 58 + b"PE\x00\x00" + b"\x00" * 128
ICAL_BYTES = (b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
              b"SUMMARY:Monthly review\r\nDTSTART:20260925T060000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


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
        save("clean_04_reply_thread.eml", make_email(
            subject="Re: 项目周报 - 智能办公平台",
            from_addr="dev01@example.com",
            from_name="后端开发 小李",
            in_reply_to="<test-1001@example.com>",
            references="<test-1000@example.com> <test-1001@example.com>",
            body="收到，联调环境我这边已经准备好。\n\n> 各位同事，本周智能办公平台项目进展如下……",
        ), "clean"),
        save("clean_05_pdf_invoice.eml", make_email(
            subject="9 月服务费发票",
            from_addr="billing@vendor-example.com",
            from_name="结算 小周",
            body="您好，\n\n附件为 9 月服务费发票，请查收。如对金额有疑问欢迎回复本邮件沟通。\n\n谢谢。",
            attachments=[("invoice-202609.pdf", "application/pdf", PDF_BYTES)],
        ), "clean"),
        save("clean_06_calendar_invite.eml", make_email(
            subject="邀请：季度复盘会",
            from_addr="calendar@example.com",
            from_name="会议助手",
            body="您有一个新的会议邀请：季度复盘会，时间 9 月 25 日 14:00-15:00。\n\n详情见日历附件。",
            attachments=[("invite.ics", "text/calendar", ICAL_BYTES)],
        ), "clean"),
        save("clean_07_csv_report.eml", make_email(
            subject="上周系统运行数据",
            from_addr="monitor@example.com",
            from_name="监控平台",
            body="各位好，\n\n附件为上周系统运行数据汇总（CSV 格式），供周报参考。",
            attachments=[("metrics-week38.csv", "text/csv", "日期,可用率,告警数\n周一,99.98%,2\n".encode("utf-8"))],
        ), "clean"),
        save("clean_08_doc_link.eml", make_email(
            subject="设计文档已更新：移动端改版",
            from_addr="docs@example.com",
            from_name="文档平台",
            body="您好，\n\n《移动端改版设计稿 v3》已更新，欢迎查阅并评论：\nhttps://docs.example.com/share/mobile-redesign-v3",
        ), "clean"),
        save("clean_09_hr_notice.eml", make_email(
            subject="关于中秋国庆假期安排的通知",
            from_addr="hr@example.com",
            from_name="人力资源部",
            body="各位同事，\n\n中秋国庆假期安排已发布在内部公告栏，请大家合理安排出行与值班。\n\n祝节日愉快。",
        ), "clean"),
        save("clean_10_expense_reminder.eml", make_email(
            subject="差旅报销单已审批通过",
            from_addr="oa@example.com",
            from_name="OA 系统",
            body="您好，\n\n您提交的 9 月差旅报销单已审批通过，预计三个工作日内到账，可在 OA 中查看进度。",
        ), "clean"),
        save("clean_11_build_notice.eml", make_email(
            subject="[CI] main 分支构建成功 #4521",
            from_addr="ci@example.org",
            from_name="构建机器人",
            body="构建 #4521 成功。\n\n提交: abc1234 fix: 修复列表分页\n产物: https://ci.example.org/builds/4521",
        ), "clean"),
        save("clean_12_meeting_minutes.eml", make_email(
            subject="会议纪要：0908 项目例会",
            from_addr="pm02@example.com",
            from_name="项目助理",
            body="各位好，\n\n今天例会纪要如下：\n1. 联调进度符合预期\n2. 下周五前完成验收材料\n3. 风险项：第三方接口排期待定\n\n请查收补充。",
        ), "clean"),
        save("clean_13_vacation_approval.eml", make_email(
            subject="请假申请已通过",
            from_addr="hr-system@example.com",
            from_name="人事系统",
            body="您好，\n\n您提交的 10 月 9 日年假申请已获批准，假勤记录已同步更新。",
        ), "clean"),
        save("clean_14_security_bulletin.eml", make_email(
            subject="本月终端安全补丁推送说明",
            from_addr="secops@example.com",
            from_name="安全运营",
            body="各位同事，\n\n本周将分批推送终端安全补丁，安装后按需重启即可。\n\n补丁说明：https://kb.example.org/patch/2026-09",
        ), "clean"),
        save("clean_15_library_notice.eml", make_email(
            subject="图书借阅到期提醒",
            from_addr="library@example.com",
            from_name="企业图书馆",
            body="您好，\n\n您借阅的《大型网站技术架构》将于下周三到期，如需续借可在图书系统自助办理。",
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
            attachments=[("发票汇总.docm",
                          "application/vnd.ms-word.document.macroEnabled.12", OLE_MACRO_BYTES)],
        ), "phishing"),
        save("phish_04_multi_turn.eml", make_email(
            subject="Re: Re: 关于合同审批",
            from_addr="partner@examp1e.com",
            from_name="合作方 李经理",
            body="方总好，\n\n合同已经按上次沟通修改，请在24小时内在附件链接中确认盖章并提供短信验证码：\nhttp://contract-example.test/s/abc123\n\n谢谢！",
        ), "phishing"),
        save("phish_05_display_spoof.eml", make_email(
            subject="账号异常：请立即重新认证",
            from_addr="it-center@secure-example.xyz",
            from_name="IT 安全中心",
            body="尊敬的用户：\n\n系统检测到您的账号存在异常登录，请立即点击链接重新认证并输入密码：\nhttps://account-verify.secure-example.xyz/auth\n\n24小时内未处理将被冻结。",
        ), "phishing"),
        save("phish_06_replyto_mismatch.eml", make_email(
            subject="差旅借款安排",
            from_addr="wang@example.com",
            from_name="王总",
            reply_to="wang@mail-temp-example.net",
            body="小王，\n\n我在外地开会，急需垫付一笔差旅费，请尽快处理转账事宜，账号信息稍后发你。\n\n事情紧急，办妥回复。",
        ), "phishing"),
        save("phish_07_ip_url.eml", make_email(
            subject="邮箱存储空间不足",
            from_addr="admin@mail-example.net",
            from_name="邮箱管理员",
            body="用户您好：\n\n您的邮箱空间已满，请立即登录升级，否则将被停用：\nhttp://45.155.23.10/mail/upgrade\n\n需输入密码完成验证。",
        ), "phishing"),
        save("phish_08_double_ext.eml", make_email(
            subject="9 月发票明细",
            from_addr="finance@vendor-example.net",
            from_name="财务",
            body="您好，\n\n附件为 9 月发票明细，请查收核对。",
            attachments=[("发票明细.pdf.exe", "application/octet-stream", PE_BYTES)],
        ), "phishing"),
        save("phish_09_shortener.eml", make_email(
            subject="快递包裹派送异常",
            from_addr="express@delivery-example.net",
            from_name="快递客服",
            body="您好，\n\n您的包裹派送失败，请立即点击链接核对收货信息并重新认证：\nhttp://t.cn/A6xK9pQ\n\n逾期包裹将被退回。",
        ), "phishing"),
        save("phish_10_punycode.eml", make_email(
            subject="网银证书即将到期",
            from_addr="bank@secure-example.net",
            from_name="银行客服",
            body="尊敬的客户：\n\n您的网银证书即将到期，请立即在线更新并输入密码确认身份：\nhttp://xn--bank-x83d.example-test.net/update\n\n逾期将无法转账。",
        ), "phishing"),
        save("phish_11_archive_exe.eml", make_email(
            subject="8 月对账单",
            from_addr="account@partner-example.net",
            from_name="往来会计",
            body="您好，\n\n附件为 8 月对账单压缩包，解压后打开查看即可。",
            attachments=[("对账单.zip", "application/zip",
                          make_zip([("对账单.exe", PE_BYTES)]))],
        ), "phishing"),
        save("phish_12_at_url.eml", make_email(
            subject="工资条已发放，请查收",
            from_addr="payroll@hr-example.net",
            from_name="薪酬组",
            body="您好，\n\n本月工资条已发放，请点击查看并输入密码验证身份：\nhttp://payroll.example.com@salary-example.net/payslip\n\n如有疑问请联系薪酬组。",
        ), "phishing"),
        save("phish_13_exe_attachment.eml", make_email(
            subject="电子回单查询工具",
            from_addr="service@bank-example.net",
            from_name="客户服务",
            body="您好，\n\n请下载附件中的回单查询工具，安装后即可查看电子回单。",
            attachments=[("回单查询工具.exe", "application/octet-stream", PE_BYTES)],
        ), "phishing"),
        save("phish_14_macro_xls.eml", make_email(
            subject="订单确认表",
            from_addr="order@supply-example.net",
            from_name="供应链协同",
            body="您好，\n\n附件为本月订单确认表，请启用内容后填写回传。",
            attachments=[("订单确认表.xls", "application/vnd.ms-excel", OLE_MACRO_BYTES)],
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
        save("spam_03_lottery.eml", make_email(
            subject="恭喜您获得周年庆抽奖资格",
            from_addr="promo@mall-sale-example.com",
            from_name="商城活动",
            body="亲爱的会员：\n\n周年庆大促进行中，满减叠加返利，还有清仓秒杀专场，点击查看团购详情。",
            list_unsubscribe="<http://unsubscribe.example.com>",
            precedence="bulk",
        ), "spam"),
        save("spam_04_loan.eml", make_email(
            subject="企业专属贷款额度已批",
            from_addr="loan@finance-promo-example.com",
            from_name="金融服务推广",
            body="尊敬的企业主：\n\n您已获得专属授信额度，本月签约享限时折扣与优惠券，详情咨询客户经理。",
            list_unsubscribe="<http://unsubscribe.example.com>",
            precedence="bulk",
        ), "spam"),
        save("spam_05_seo.eml", make_email(
            subject="网站排名推广服务",
            from_addr="seo@rank-boost-example.com",
            from_name="推广顾问",
            body="您好：\n\n搜索引擎首页排名推广，签约送优惠券，季度套餐限时折扣，欢迎咨询。",
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
