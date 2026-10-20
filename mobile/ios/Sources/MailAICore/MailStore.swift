import Foundation
import Observation

public struct ReadResult: Sendable {
    public var body: MailBody
    public var markedRead: Bool
    public init(body: MailBody, markedRead: Bool) { self.body = body; self.markedRead = markedRead }
}

public struct SubmissionFailure: Error, Sendable {
    public var uncertain: Bool
    public init(uncertain: Bool) { self.uncertain = uncertain }
}

public protocol MailService: Sendable {
    func validate(_ credential: AccountCredential) async throws
    func folders(_ credential: AccountCredential) async throws -> [MailFolder]
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary]
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult
    func send(_ credential: AccountCredential, draft: MailDraft) async throws
}

@MainActor @Observable public final class MailStore {
    public private(set) var accounts: [MailAccount] = []
    public private(set) var selectedID: UUID?
    public private(set) var folders: [MailFolder] = [.init(name: "INBOX")]
    public private(set) var folder = "INBOX"
    public private(set) var messages: [MailSummary] = []
    public private(set) var draft = MailDraft()
    public private(set) var busy = false
    public private(set) var sending = false
    public private(set) var lastRefresh: Date?
    public var error: String?
    @ObservationIgnored private let vault: CredentialStorage
    @ObservationIgnored private let files: MailFiles
    @ObservationIgnored private let service: any MailService
    @ObservationIgnored private var credentials: [AccountCredential] = []
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var limit = 50

    public init(vault: CredentialStorage, files: MailFiles, service: any MailService) {
        self.vault = vault; self.files = files; self.service = service
        do {
            credentials = try vault.load(); accounts = credentials.map(\.account)
            if let first = accounts.first { try selectAccount(first.id) }
        } catch { self.error = "本地数据读取失败：\(error.localizedDescription)" }
    }
    public var selected: MailAccount? { accounts.first { $0.id == selectedID } }
    private func credential() throws -> AccountCredential {
        guard let value = credentials.first(where: { $0.account.id == selectedID }) else { throw MailFailure.missingPassword }
        return value
    }
    public func addAccount(_ input: MailAccount, password: String) async throws {
        let account = try input.validated()
        guard !password.isEmpty else { throw MailFailure.invalid("请填写密码或邮箱授权码。") }
        guard !accounts.contains(where: { $0.email.lowercased() == account.email.lowercased() }) else {
            throw MailFailure.invalid("这个邮箱已添加。修改服务器配置请先移除该账号后重新添加。")
        }
        let entry = AccountCredential(account: account, password: password)
        try await service.validate(entry)
        let updated = credentials + [entry]
        try vault.save(updated)
        credentials = updated; accounts = updated.map(\.account)
        try selectAccount(account.id)
        refresh()
    }
    public func selectAccount(_ id: UUID) throws {
        guard !sending else { throw MailFailure.invalid("请等待当前邮件发送结束后切换账号。") }
        guard credentials.contains(where: { $0.account.id == id }) else { throw MailFailure.missingPassword }
        cancelRefresh(); selectedID = id; folder = "INBOX"; limit = 50; draft = MailDraft()
        folders = try files.read([MailFolder].self, account: id, key: "folders") ?? [.init(name: "INBOX")]
        try loadCache()
        draft = try files.read(MailDraft.self, account: id, key: "draft") ?? MailDraft()
        draft.recoverAfterInterruption()
        try files.write(draft, account: id, key: "draft")
    }
    public func selectFolder(_ name: String) throws {
        cancelRefresh(); folder = name; limit = 50; try loadCache(); refresh()
    }
    private func loadCache() throws {
        messages = []; lastRefresh = nil
        if let id = selectedID { messages = try files.read([MailSummary].self, account: id, key: "list:" + folder) ?? [] }
    }
    public func cancelRefresh() {
        generation = UUID(); syncTask?.cancel(); syncTask = nil; busy = false
    }
    public func refresh(more: Bool = false) {
        guard selectedID != nil else { return }
        cancelRefresh()
        if more { limit = min(500, limit + 50) }
        let token = generation; let folder = self.folder; let limit = self.limit
        busy = true
        syncTask = Task { [weak self] in
            guard let self else { return }
            do {
                let entry = try credential()
                let list = try await service.folders(entry)
                let result = try await service.summaries(entry, folder: folder, limit: limit)
                try Task.checkCancellation()
                guard generation == token else { return }
                try files.write(list, account: entry.account.id, key: "folders")
                try files.write(result, account: entry.account.id, key: "list:" + folder)
                folders = list; messages = result; lastRefresh = Date()
            } catch {
                if generation == token, !Task.isCancelled { self.error = "收信失败，已保留缓存。请检查网络、服务器与授权码后重试。" }
            }
            if generation == token { busy = false }
        }
    }
    public func body(for summary: MailSummary) async throws -> MailBody {
        let entry = try credential()
        if let cached = try files.read(MailBody.self, account: entry.account.id, key: "body:" + summary.id) { return cached }
        let result = try await service.read(entry, summary: summary)
        try Task.checkCancellation()
        try files.write(result.body, account: entry.account.id, key: "body:" + summary.id)
        if selectedID == entry.account.id, folder == summary.folder, result.markedRead,
           let index = messages.firstIndex(where: { $0.id == summary.id }) {
            messages[index].unread = false
            try files.write(messages, account: entry.account.id, key: "list:" + summary.folder)
        }
        return result.body
    }
    public func updateDraft(_ update: (inout MailDraft) -> Void) {
        guard !sending, draft.state == .editing, let id = selectedID else { return }
        var next = draft; update(&next)
        do { try files.write(next, account: id, key: "draft"); draft = next }
        catch { self.error = "草稿保存失败，请保留编辑页面并重试。" }
    }
    public func newDraft(replyingTo summary: MailSummary? = nil) throws {
        guard !sending, let id = selectedID else { return }
        var next = MailDraft()
        if let summary {
            next.to = summary.replyAddress
            next.subject = summary.subject.lowercased().hasPrefix("re:") ? summary.subject : "Re: " + summary.subject
            next.inReplyTo = summary.messageID
        }
        try files.write(next, account: id, key: "draft"); draft = next
    }
    public func resolveUncertain() throws {
        guard draft.state == .uncertain, let id = selectedID else { return }
        var next = draft; next.state = .editing
        try files.write(next, account: id, key: "draft"); draft = next
    }
    public func send() async throws {
        guard !sending else { return }
        _ = try draft.validateForSending()
        let entry = try credential()
        let id = entry.account.id
        var submitted = draft; submitted.state = .submitting
        // Persist BEFORE SMTP; interrupted submissions must never look retryable on restart.
        try files.write(submitted, account: id, key: "draft")
        draft = submitted; sending = true
        defer { sending = false }
        do {
            try await service.send(entry, draft: submitted)
            submitted.state = .sent
            try files.write(submitted, account: id, key: "draft")
            if selectedID == id { draft = submitted }
        } catch {
            let uncertain = (error as? SubmissionFailure)?.uncertain ?? true
            submitted.state = uncertain ? .uncertain : .editing
            // Even a disk failure leaves the durable state as submitting (conservative recovery).
            try? files.write(submitted, account: id, key: "draft")
            if selectedID == id { draft = submitted }
            if uncertain { throw MailFailure.uncertainSend }
            throw MailFailure.invalid("邮件未发送，请检查网络、授权码及收件地址后手动重试。")
        }
    }
    public func removeSelectedAccount() throws {
        guard !sending, let id = selectedID else { return }
        let updated = credentials.filter { $0.account.id != id }
        try vault.save(updated)
        cancelRefresh(); credentials = updated; accounts = updated.map(\.account)
        selectedID = nil; messages = []; folders = [.init(name: "INBOX")]; draft = MailDraft()
        try files.remove(account: id)
        if let first = accounts.first { try selectAccount(first.id); refresh() }
    }
}
