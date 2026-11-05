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
    private actor Service: MailService {
        var removed = Set<String>()
        var origins: [String: MailSummary] = [:]
        var nextUID: UInt32 = 1000
        func validate(_ credential: AccountCredential) async throws {
            if CommandLine.arguments.contains("--ui-account-failure") {
                try await Task.sleep(for: .seconds(12))
                throw MailFailure.invalid("收信连接未完成，请检查密码／授权码或服务器设置。")
            }
        }
        func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Archive"), .init(name: "Sent"), .init(name: "Trash")] }
        func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] {
            if CommandLine.arguments.contains("--ui-offline") { throw MailFailure.invalid("合成离线状态") }
            return CommandLine.arguments.contains("--ui-empty-inbox") ? [] : DebugPreview.messages(folder: folder).filter { !removed.contains($0.id) }
        }
        func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult {
            if CommandLine.arguments.contains("--ui-read-failure") { throw MailFailure.invalid("合成正文读取失败，可重试。") }
            let html: String?
            if CommandLine.arguments.contains("--ui-html-wide") {
                html = DebugPreview.wideHTML
            } else if CommandLine.arguments.contains("--ui-html-legacy") {
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
        func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws {
            if case .move = action { for item in summaries { if let original = origins[item.id] { removed.remove(original.id) } } }
        }
        func move(_ credential: AccountCredential, summaries: [MailSummary], to folder: String) async throws -> [MailSummary]? {
            if CommandLine.arguments.contains("--ui-correspondence-move-failure"), summaries.first?.folder == "INBOX" { throw MailFailure.invalid("合成移动未确认") }
            return summaries.map {
                nextUID += 1; let moved = $0.relocated(uid: nextUID, validity: 20, folder: folder)
                removed.insert($0.id); origins[moved.id] = $0; return moved
            }
        }
        func correspondence(_ credential: AccountCredential, folder: String, address: String, limit: Int) async throws -> MailSearchResult {
            if CommandLine.arguments.contains("--ui-correspondence-failure") { throw MailFailure.invalid("合成往来查询失败") }
            var source: [MailSummary]
            if folder == "Sent" {
                var sent = MailSummary(uid: 77, validity: 10, folder: folder, subject: "已发送的合成回复", sender: "测试邮箱 <demo@example.com>", replyAddress: "demo@example.com", date: Date(timeIntervalSince1970: 1793103000), unread: false, messageID: "<sent-correspondence@example.com>")
                sent.senderAddress = "demo@example.com"; sent.senderName = "测试邮箱"; sent.recipients = [.init(name: "测试联系人", email: "sender@example.com")]
                source = [sent]
            } else { source = DebugPreview.messages(folder: folder) }
            if folder == "INBOX", CommandLine.arguments.contains("--ui-correspondence-many") {
                for index in 1...205 {
                    var item = DebugPreview.messages(folder: folder)[0].relocated(uid: UInt32(100+index), validity: 10, folder: folder)
                    item.subject = "合成历史往来 \(index)"; item.messageID = "<bulk-\(index)@example.com>"; source.append(item)
                }
            }
            let matches = source.filter { $0.involves(address) && !removed.contains($0.id) }.sorted { $0.uid > $1.uid }
            return MailSearchResult(messages: Array(matches.prefix(limit)), total: matches.count)
        }
        func correspondencePage(_ credential: AccountCredential, folder: String, address: String, beforeUID: UInt32?, limit: Int) async throws -> MailSearchResult {
            let all = try await correspondence(credential, folder: folder, address: address, limit: Int.max)
            let remaining = all.messages.filter { beforeUID == nil || $0.uid < beforeUID! }
            let chosen = Array(remaining.prefix(limit))
            return MailSearchResult(messages: chosen, total: all.total, nextUID: remaining.count > chosen.count ? chosen.last?.uid : nil)
        }
        func search(_ credential: AccountCredential, folder: String, query: String, limit: Int) async throws -> MailSearchResult {
            guard CommandLine.arguments.contains("--ui-server-search") else { throw MailFailure.invalid("合成服务器搜索失败") }
            let matches = DebugPreview.messages(folder: folder).filter { ($0.subject + $0.sender + ($0.preview ?? "")).localizedCaseInsensitiveContains(query) }
            return MailSearchResult(messages: Array(matches.prefix(limit)), total: matches.count)
        }
        func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws {}
    }
    nonisolated static var wideHTML: String {
        let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><rect width='180' height='180' fill='white'/><path fill='black' d='M10 10h50v50H10z M120 10h50v50h-50z M10 120h50v50H10z M80 10h20v30H80z M80 60h40v20H80z M70 100h30v50H70z M120 100h50v20h-50z M120 140h30v30h-30z'/></svg>"
        let image = Data(svg.utf8).base64EncodedString()
        return """
        <meta name="viewport" content="width=1200,user-scalable=no">
        <table width="800" style="width:800px;min-width:800px;background:#f7f7f7;color:#555"><tr><td style="padding:36px">
        <h2 id="wide-start">合成通知完整阅读</h2><p>这是一封固定桌面宽度的合成邮件，用于确认手机不会裁掉右侧内容。</p>
        <table width="728"><tr><td width="480">通知说明与长行内容，应完整显示在页面范围内。</td><td width="220" align="right"><img id="wide-image" alt="合成二维码" width="180" height="180" src="data:image/svg+xml;base64,\(image)"></td></tr></table>
        <p align="right"><a id="wide-action" href="https://example.com/synthetic-details" style="display:inline-block;padding:14px 24px;background:#008870;color:white">查看合成详情</a></p>
        <p id="wide-end">正文末尾：这行内容也应完整显示。</p></td></tr></table>
        <script>window.untrustedMailScriptRan=true</script>
        """
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
    static var notificationService: any MailService { Service() }
    static var notificationCredentials: [AccountCredential] {
        var account = MailAccount(id: UUID(uuidString: "00000000-0000-0000-0000-000000000011")!)
        account.email = "demo@example.com"; account.suggestServers()
        return [.init(account: account, password: "synthetic-notification-only")]
    }
    static func store() throws -> MailStore {
        UserDefaults.standard.set(false, forKey: "mail.background")
        UserDefaults.standard.set(false, forKey: "mail.notificationPreview")
        BackgroundMail.shared.stop()
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
        if CommandLine.arguments.contains("--ui-start-trash") { try files.write(messages(folder: "Trash"), account: account.id, key: "list:Trash") }
        var entries = [AccountCredential(account: account, password: "synthetic-ui-only")]
        if CommandLine.arguments.contains("--ui-multiple-accounts") {
            var second = MailAccount(); second.email = "second@example.com"; second.suggestServers()
            entries.append(.init(account: second, password: "synthetic-ui-only"))
        }
        let result = MailStore(vault: Vault(CommandLine.arguments.contains("--ui-empty-accounts") ? [] : entries), files: files, service: Service())
        if CommandLine.arguments.contains("--ui-start-trash") { try result.selectFolder("Trash") }
        if CommandLine.arguments.contains("--ui-notification-open") {
            BackgroundMail.shared.pendingTarget = .init(accountID: account.id, uid: 7, validity: CommandLine.arguments.contains("--ui-stale-notification") ? 99 : 10)
        }
        return result
    }
}
#endif
