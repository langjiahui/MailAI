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
        func validate(_ credential: AccountCredential) async throws {}
        func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Archive"), .init(name: "Sent")] }
        func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { DebugPreview.messages(folder: folder) }
        func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult {
            .init(body: .init(text: "这是一封用于界面验收的合成邮件。\n请于周五前确认测试材料。", html: nil,
                attachments: [.init(id: "2", name: "测试说明.txt", mimeType: "text/plain", size: 9)],
                recipients: [.init(name: "测试用户", email: "demo@example.com"), .init(name: "协作人", email: "team@example.com")]), markedRead: true)
        }
        func send(_ credential: AccountCredential, draft: MailDraft) async throws { throw SubmissionFailure(uncertain: false) }
        func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data { Data("synthetic".utf8) }
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
        try files.write(messages(folder: "INBOX"), account: account.id, key: "list:INBOX")
        try files.write([MailContact(email: "team@example.com", name: "协作联系人", note: "项目组")], account: account.id, key: "contacts")
        UserDefaults.standard.set(CommandLine.arguments.contains("--ui-dark") ? "dark" : "light", forKey: "mail.appearance")
        return MailStore(vault: Vault([.init(account: account, password: "synthetic-ui-only")]), files: files, service: Service())
    }
}
#endif
