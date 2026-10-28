#if DEBUG
import Foundation
import MailAICore

@MainActor enum DebugPreview {
    private final class Vault: CredentialStorage {
        var credentials: [AccountCredential]
        init(_ credentials: [AccountCredential]) { self.credentials = credentials }
        func load() throws -> [AccountCredential] { credentials }
        func save(_ values: [AccountCredential]) throws { credentials = values }
    }
    private struct Service: MailService {
        func validate(_ credential: AccountCredential) async throws {
            if CommandLine.arguments.contains("--ui-account-failure") {
                try await Task.sleep(for: .seconds(2))
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
            let html: String? = CommandLine.arguments.contains("--ui-html") ? "<p>这是一封合成 HTML 邮件。</p><p><a href='https://example.com'>测试外部链接</a></p>" : nil
            return .init(body: .init(text: "这是一封用于界面验收的合成邮件。\n请于周五前确认测试材料。", html: html,
                attachments: [.init(id: "2", name: "测试说明.txt", mimeType: "text/plain", size: 9)],
                recipients: [.init(name: "测试用户", email: "demo@example.com"), .init(name: "协作人", email: "team@example.com")]), markedRead: true)
        }
        func send(_ credential: AccountCredential, draft: MailDraft) async throws { throw SubmissionFailure(uncertain: false) }
        func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data {
            if CommandLine.arguments.contains("--ui-attachment-slow") { try await Task.sleep(for: .seconds(4)) }
            if CommandLine.arguments.contains("--ui-attachment-failure") { throw MailFailure.invalid("合成附件下载失败，正文保留。") }
            return Data("synthetic".utf8)
        }
        func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws {}
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
        return result
    }
    static func store() throws -> MailStore {
        var account = MailAccount(); account.email = "demo@example.com"; account.displayName = "测试邮箱"; account.suggestServers()
        let files = try MailFiles(root: FileManager.default.temporaryDirectory.appendingPathComponent("MailAI-UI-" + UUID().uuidString))
        try files.write(CommandLine.arguments.contains("--ui-empty-inbox") ? [] : messages(folder: "INBOX"), account: account.id, key: "list:INBOX")
        try files.write([MailContact(email: "team@example.com", name: "协作联系人", note: "项目组")], account: account.id, key: "contacts")
        if CommandLine.arguments.contains("--ui-records") {
            var editing = MailDraft(); editing.to = "draft@example.com"; editing.subject = "合成待办草稿"; editing.text = "用于设计验收的草稿正文。"
            var unknown = MailDraft(); unknown.to = "unknown@example.com"; unknown.subject = "合成待确认记录"; unknown.text = "发送结果需要核对。"; unknown.state = .uncertain
            var sent = MailDraft(); sent.to = "sent@example.com"; sent.subject = "合成副本待存档"; sent.text = "服务器已接受的合成内容。"; sent.state = .sent; sent.sentCopyPending = true
            try files.write([editing, unknown, sent], account: account.id, key: "drafts-v2")
        }
        UserDefaults.standard.set(CommandLine.arguments.contains("--ui-dark") ? "dark" : "light", forKey: "mail.appearance")
        return MailStore(vault: Vault(CommandLine.arguments.contains("--ui-empty-accounts") ? [] : [.init(account: account, password: "synthetic-ui-only")]), files: files, service: Service())
    }
}
#endif
