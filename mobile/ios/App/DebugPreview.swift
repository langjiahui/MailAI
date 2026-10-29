#if DEBUG
import Foundation
import UIKit
import MailAICore

@MainActor enum DebugPreview {
    private static var accountDirectory: URL?
    static func makeStorageReadOnly() throws {
        guard let directory = accountDirectory else { throw MailFailure.invalid("合成存储目录不可用") }
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    }
    private final class Vault: CredentialStorage {
        var credentials: [AccountCredential]
        init(_ credentials: [AccountCredential]) { self.credentials = credentials }
        func load() throws -> [AccountCredential] { credentials }
        func save(_ values: [AccountCredential]) throws { credentials = values }
    }
    private struct Service: MailService {
        func validate(_ credential: AccountCredential) async throws {
            if CommandLine.arguments.contains("--ui-account-failure") {
                try await Task.sleep(for: .seconds(12))
                throw MailFailure.invalid("收信连接未完成，请检查密码／授权码或服务器设置。")
            }
        }
        func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Archive"), .init(name: "Sent")] }
        func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] {
            if CommandLine.arguments.contains("--ui-offline") { throw MailFailure.invalid("合成离线状态") }
            return CommandLine.arguments.contains("--ui-empty-inbox") ? [] : DebugPreview.messages(folder: folder)
        }
        func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult {
            if CommandLine.arguments.contains("--ui-read-failure") { throw MailFailure.invalid("合成正文读取失败，可重试。") }
            let html: String?
            if CommandLine.arguments.contains("--ui-html-legacy") {
                html = """
                <div style="font-family:Arial;color:#000000"><p><font color="black">企业邮件正文：请确认本周工作安排。</font></p>
                <table cellspacing="0" cellpadding="8" style="border-collapse:collapse;color:#000000"><tr><td style="border:1px solid #777777">项目</td><td style="border:1px solid #777777">处理时间</td></tr><tr><td style="border:1px solid #777777">资料确认</td><td style="border:1px solid #777777"><span style="color:#ff0000">周五前完成</span></td></tr></table>
                <p><a href="https://example.com">测试外部链接</a></p></div>
                """
            } else {
                html = CommandLine.arguments.contains("--ui-html") ? "<p>这是一封合成 HTML 邮件。</p><p><a href='https://example.com'>测试外部链接</a></p>" : nil
            }
            let attachment: MailAttachment
            if CommandLine.arguments.contains("--ui-pdf") {
                let data = await MainActor.run { DebugPreview.pdfData() }
                attachment = .init(id: "pdf", name: "合成项目方案.pdf", mimeType: "application/pdf", size: data.count)
            } else { attachment = .init(id: "2", name: "测试说明.txt", mimeType: "text/plain", size: 9) }
            return .init(body: .init(text: "这是一封用于界面验收的合成邮件。\n请于周五前确认测试材料。", html: html,
                attachments: [attachment],
                recipients: [.init(name: "测试用户", email: "demo@example.com"), .init(name: "协作人", email: "team@example.com")]), markedRead: true)
        }
        func send(_ credential: AccountCredential, draft: MailDraft) async throws {
            if CommandLine.arguments.contains("--ui-send-slow") { try await Task.sleep(for: .seconds(12)) }
            throw SubmissionFailure(uncertain: false)
        }
        func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data {
            if CommandLine.arguments.contains("--ui-attachment-slow") { try await Task.sleep(for: .seconds(4)) }
            if CommandLine.arguments.contains("--ui-attachment-failure") { throw MailFailure.invalid("合成附件下载失败，正文保留。") }
            if attachment.mimeType == "application/pdf" { return await MainActor.run { DebugPreview.pdfData() } }
            return Data("synthetic".utf8)
        }
        func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws {}
        func search(_ credential: AccountCredential, folder: String, query: String, limit: Int) async throws -> MailSearchResult {
            guard CommandLine.arguments.contains("--ui-server-search") else { throw MailFailure.invalid("合成服务器搜索失败") }
            let matches = DebugPreview.messages(folder: folder).filter { ($0.subject + $0.sender + ($0.preview ?? "")).localizedCaseInsensitiveContains(query) }
            return MailSearchResult(messages: Array(matches.prefix(limit)), total: matches.count)
        }
        func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws {}
    }
    nonisolated static func messages(folder: String) -> [MailSummary] {
        var item = MailSummary(uid: 7, validity: 10, folder: folder, subject: "项目资料确认与下一步安排", sender: "测试联系人 <sender@example.com>", replyAddress: "sender@example.com", date: Date(timeIntervalSince1970: 1793102400), unread: true, messageID: "<ui-synthetic@example.com>")
        item.senderName = "测试联系人"; item.preview = "请核对附件并确认下一步安排。仅用于界面验收。"; item.hasAttachments = true
        let titles = ["移动端设计评审", "合同修订版本", "会议纪要与行动项", "十月报销说明", "版本计划确认"]
        let senders = ["设计团队", "协作联系人", "项目组", "财务部", "产品团队"]
        var result = [item]
        for index in titles.indices {
            var extra = MailSummary(uid: UInt32(8 + index), validity: 10, folder: folder, subject: titles[index], sender: senders[index] + " <team@example.com>", replyAddress: "team@example.com", date: Date(timeIntervalSince1970: 1793102000 - Double(index * 3600)), unread: index == 1, messageID: "<ui-\(index)@example.com>")
            extra.senderName = senders[index]; extra.preview = "仅用于界面验收的合成内容，请确认下一步安排。"; extra.isFlagged = index == 0; extra.hasAttachments = index == 1
            result.append(extra)
        }
        if CommandLine.arguments.contains("--ui-long-inbox") {
            for index in 7...36 {
                var extra = MailSummary(uid: UInt32(100 + index), validity: 10, folder: folder,
                    subject: "滚动测试邮件 \(index)", sender: "回归测试 <scroll@example.com>", replyAddress: "scroll@example.com",
                    date: Date(timeIntervalSince1970: 1793000000 - Double(index * 3600)), unread: false, messageID: "<scroll-\(index)@example.com>")
                extra.senderName = "回归测试"; extra.preview = "用于验证搜索筛选随邮件列表滚动。"
                result.append(extra)
            }
        }
        if CommandLine.arguments.contains("--ui-threads"), result.count > 1 {
            result[1].parentMessageID = item.messageID; result[1].subject = "Re: " + item.subject
        }
        if CommandLine.arguments.contains("--ui-header-only") { for index in result.indices { result[index].preview = nil } }
        return result
    }
    static func pdfData() -> Data {
        UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842)).pdfData { context in
            context.beginPage()
            let text = "合成项目方案\n\n仅用于 MailAI 界面验收\n\n项目背景与本周安排\n请确认测试材料并反馈下一步计划。"
            (text as NSString).draw(in: CGRect(x: 48, y: 72, width: 499, height: 650), withAttributes: [.font: UIFont.systemFont(ofSize: 24), .foregroundColor: UIColor.label])
        }
    }
    static func store() throws -> MailStore {
        var account = MailAccount(); account.email = "demo@example.com"; account.displayName = "测试邮箱"; account.suggestServers()
        let cacheRoot = FileManager.default.temporaryDirectory.appendingPathComponent("MailAI-UI-" + UUID().uuidString)
        let files = try MailFiles(root: cacheRoot)
        accountDirectory = cacheRoot.appendingPathComponent(account.id.uuidString)
        try files.write(CommandLine.arguments.contains("--ui-empty-inbox") ? [] : messages(folder: "INBOX"), account: account.id, key: "list:INBOX")
        try files.write([MailContact(email: "team@example.com", name: "协作联系人", note: "项目组")], account: account.id, key: "contacts")
        if CommandLine.arguments.contains("--ui-records") {
            var editing = MailDraft(); editing.to = "draft@example.com"; editing.subject = "合成待办草稿"; editing.text = "用于设计验收的草稿正文。"; editing.attachments = [.init(name: "合成附件.txt", mimeType: "text/plain", data: Data("synthetic".utf8))]
            var unknown = MailDraft(); unknown.to = "unknown@example.com"; unknown.subject = "合成待确认记录"; unknown.text = "发送结果需要核对。"; unknown.state = .uncertain
            var sent = MailDraft(); sent.to = "sent@example.com"; sent.subject = "合成副本待存档"; sent.text = "服务器已接受的合成内容。"; sent.state = .sent; sent.sentCopyPending = true
            try files.write([editing, unknown, sent], account: account.id, key: "drafts-v2")
        }
        UserDefaults.standard.set(CommandLine.arguments.contains("--ui-dark") ? "dark" : "light", forKey: "mail.appearance")
        return MailStore(vault: Vault(CommandLine.arguments.contains("--ui-empty-accounts") ? [] : [.init(account: account, password: "synthetic-ui-only")]), files: files, service: Service())
    }
}
#endif
