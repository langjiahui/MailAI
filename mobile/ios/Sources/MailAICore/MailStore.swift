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
    func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data
    func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws
    func search(_ credential: AccountCredential, folder: String, query: String, limit: Int) async throws -> MailSearchResult
    func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws
    func move(_ credential: AccountCredential, summaries: [MailSummary], to folder: String) async throws -> [MailSummary]?
}
public extension MailService {
    func move(_ credential: AccountCredential, summaries: [MailSummary], to folder: String) async throws -> [MailSummary]? {
        try await perform(credential, summaries: summaries, action: .move(folder)); return nil
    }
    func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data { throw MailFailure.invalid("当前服务不支持附件下载。") }
    func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws { throw MailFailure.invalid("当前服务不支持邮件整理。") }
    func search(_ credential: AccountCredential, folder: String, query: String, limit: Int) async throws -> MailSearchResult { throw MailFailure.invalid("当前服务不支持服务器搜索。") }
    func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws { throw MailFailure.invalid("已发送副本尚未保存。邮件已提交，请勿重复发送。") }
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
    public private(set) var draftSaveFailed = false
    public private(set) var lastRefresh: Date?
    public private(set) var drafts: [MailDraft] = []
    public private(set) var contacts: [MailContact] = []
    public private(set) var operating = false
    public private(set) var searchTotal = 0
    public private(set) var undoID: UUID?
    public private(set) var undoTitle = ""
    @ObservationIgnored private var undoAccount: UUID?
    @ObservationIgnored private var undoExpiry = Date.distantPast
    @ObservationIgnored private var undoActions: [(MailAction, [MailSummary])] = []
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
            throw MailFailure.invalid("这个邮箱已添加，请在账号设置编辑配置。")
        }
        let entry = AccountCredential(account: account, password: password)
        try await service.validate(entry)
        try Task.checkCancellation()
        let updated = credentials + [entry]
        try vault.save(updated)
        credentials = updated; accounts = updated.map(\.account)
        try selectAccount(account.id)
        refresh()
    }
    public func selectAccount(_ id: UUID) throws {
        guard !sending, !operating else { throw MailFailure.invalid("请等待当前邮件操作结束后切换账号。") }
        if draftSaveFailed { try saveDraft() }
        guard credentials.contains(where: { $0.account.id == id }) else { throw MailFailure.missingPassword }
        cancelRefresh(); clearUndo(); selectedID = id; folder = "INBOX"; limit = 50; draft = MailDraft(); draftSaveFailed = false
        folders = try files.read([MailFolder].self, account: id, key: "folders") ?? [.init(name: "INBOX")]
        try loadCache()
        draft = try files.read(MailDraft.self, account: id, key: "draft") ?? MailDraft()
        if draft.identifier == nil { draft.identifier = UUID().uuidString }
        draft.recoverAfterInterruption()
        drafts = try files.read([MailDraft].self, account: id, key: "drafts-v2") ?? []
        contacts = try files.read([MailContact].self, account: id, key: "contacts") ?? []
        try persistDraft()
        try learnContacts(messages.flatMap(\.contactAddresses), account: id)
    }
    public func selectFolder(_ name: String) throws {
        cancelRefresh(); folder = name; limit = 50; try loadCache()
        if let id = selectedID { try learnContacts(messages.flatMap(\.contactAddresses), account: id) }
        refresh()
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
                try learnContacts(result.flatMap(\.contactAddresses), account: entry.account.id)
            } catch {
                if generation == token, !Task.isCancelled { self.error = "收信失败，已保留缓存。请检查网络、服务器与授权码后重试。" }
            }
            if generation == token { busy = false }
        }
    }
    public func body(for summary: MailSummary, refreshMetadata: Bool = false) async throws -> MailBody {
        let entry = try credential()
        if let cached = try files.read(MailBody.self, account: entry.account.id, key: "body:" + summary.id), !refreshMetadata || cached.attachments != nil {
            try? learnContacts(summary.contactAddresses + (cached.recipients ?? []) + (cached.carbonCopies ?? []), account: entry.account.id)
            return cached
        }
        let result = try await service.read(entry, summary: summary)
        try Task.checkCancellation()
        try files.write(result.body, account: entry.account.id, key: "body:" + summary.id)
        try? learnContacts(summary.contactAddresses + (result.body.recipients ?? []) + (result.body.carbonCopies ?? []), account: entry.account.id)
        if selectedID == entry.account.id, folder == summary.folder, result.markedRead,
           let index = messages.firstIndex(where: { $0.id == summary.id }) {
            messages[index].unread = false
            messages[index].preview = String(result.body.text.replacingOccurrences(of: "\n", with: " ").prefix(180))
            try files.write(messages, account: entry.account.id, key: "list:" + summary.folder)
        }
        return result.body
    }
    public func markReadIfNeeded(_ summary: MailSummary) async throws {
        let entry = try credential()
        guard messages.first(where: { $0.id == summary.id })?.unread == true else { return }
        try await service.perform(entry, summaries: [summary], action: .read(true)); try Task.checkCancellation()
        guard selectedID == entry.account.id, folder == summary.folder, let index = messages.firstIndex(where: { $0.id == summary.id }) else { return }
        messages[index].unread = false
        try files.write(messages, account: entry.account.id, key: "list:" + folder)
    }
    public func updateDraft(_ update: (inout MailDraft) -> Void) {
        guard !sending, draft.state == .editing, selectedID != nil else { return }
        var next = draft; update(&next); next.updatedAt = Date(); draft = next
        do { try persistDraft(); draftSaveFailed = false }
        catch { draftSaveFailed = true; self.error = "草稿保存失败，输入仍保留在当前页面，请重试保存。" }
    }
    public func saveDraft() throws {
        try persistDraft()
        draftSaveFailed = false
    }
    public func newDraft(replyingTo summary: MailSummary? = nil) throws {
        guard !sending, selectedID != nil else { return }
        try saveDraft()
        var next = MailDraft()
        next.text = selected?.signature ?? ""
        if let summary {
            next.to = summary.replyAddress
            next.subject = summary.subject.lowercased().hasPrefix("re:") ? summary.subject : "Re: " + summary.subject
            next.inReplyTo = summary.messageID
        }
        draft = next; try persistDraft(); draftSaveFailed = false
    }
    public func resolveUncertain() throws {
        guard draft.state == .uncertain, selectedID != nil else { return }
        var next = draft; next.state = .editing
        draft = next; try persistDraft()
    }
    public func send() async throws {
        guard !sending else { return }
        _ = try draft.validateForSending()
        let entry = try credential()
        let id = entry.account.id
        let attachments = draft.attachments
        var submitted = try hydrated(draft, account: id); submitted.state = .submitting
        var durable = submitted; durable.attachments = attachments
        // Persist BEFORE SMTP; keep attachment payloads in their separate protected files.
        try files.write(durable, account: id, key: "draft")
        draft = durable; draftSaveFailed = false; sending = true
        defer { sending = false }
        do {
            try await service.send(entry, draft: submitted)
            submitted.state = .sent
            submitted.sentCopyPending = entry.account.shouldSaveSentCopy
            submitted.attachments = attachments
            draft = submitted
            try persistDraft()
            let groups = try submitted.recipientGroups()
            try? learnContacts((groups.to + groups.cc + groups.bcc).map { MailAddress(email: $0) }, account: id)
            if entry.account.shouldSaveSentCopy {
                do {
                    try await service.archiveSent(entry, draft: try hydrated(submitted, account: id))
                    draft.sentCopyPending = false; try persistDraft()
                } catch {
                    self.error = "邮件已提交，但已发送副本保存失败。可在草稿记录中重试存档，请勿重复发送。"
                }
            }
        } catch {
            if submitted.state == .sent {
                draft = submitted; draftSaveFailed = true
                throw MailFailure.invalid("邮件已提交，但本地状态保存失败。请勿重复发送。")
            }
            submitted.attachments = attachments
            let uncertain = (error as? SubmissionFailure)?.uncertain ?? true
            submitted.state = uncertain ? .uncertain : .editing
            // Even a disk failure leaves the durable state as submitting (conservative recovery).
            try? files.write(submitted, account: id, key: "draft")
            if selectedID == id { draft = submitted; try? persistDraft() }
            if uncertain { throw MailFailure.uncertainSend }
            throw MailFailure.invalid("邮件未发送，请检查网络、授权码及收件地址后手动重试。")
        }
    }
    private func persistDraft() throws {
        guard let id = selectedID else { return }
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) { drafts[index] = draft }
        else if !draft.isEmpty { drafts.insert(draft, at: 0) }
        try files.write(draft, account: id, key: "draft")
        try files.write(drafts, account: id, key: "drafts-v2")
    }
    public func openDraft(_ id: String) throws {
        guard !sending else { return }
        try saveDraft()
        guard let next = drafts.first(where: { $0.id == id }) else { return }
        draft = next; try persistDraft()
    }
    public func discardDraft(_ id: String) throws {
        guard !sending else { return }
        guard !drafts.contains(where: { $0.id == id && ($0.state == .uncertain || $0.state == .submitting) }) else { throw MailFailure.uncertainSend }
        drafts.removeAll { $0.id == id }
        if draft.id == id { draft = MailDraft() }
        try persistDraft()
    }
    public func compose(mode: DraftMode, summary: MailSummary, body: MailBody) throws {
        try newDraft()
        var next = draft
        let quoted = "\n\n—— 原邮件 ——\n\(summary.sender)\n\(summary.subject)\n\(body.text)"
        if mode == .forward {
            next.subject = "Fwd: " + summary.subject
            next.text += quoted
        } else {
            let own = selected?.email.lowercased() ?? ""
            let recipients = body.recipients ?? summary.recipients ?? []
            next.to = summary.replyAddress.lowercased() == own ? recipients.filter { $0.email.lowercased() != own }.map(\.email).joined(separator: ", ") : summary.replyAddress
            next.subject = summary.subject.lowercased().hasPrefix("re:") ? summary.subject : "Re: " + summary.subject
            next.inReplyTo = summary.messageID
            if mode == .replyAll {
                var seen = Set([selected?.email.lowercased() ?? "", summary.replyAddress.lowercased()])
                next.cc = ((body.recipients ?? summary.recipients ?? []) + (body.carbonCopies ?? summary.carbonCopies ?? []))
                    .filter { seen.insert($0.email.lowercased()).inserted }.map(\.email).joined(separator: ", ")
            }
            next.text += quoted
        }
        draft = next; try persistDraft()
    }
    public func addAttachment(name: String, mimeType: String, data: Data) throws {
        guard let id = selectedID, draft.state == .editing else { return }
        guard data.count <= MailAttachment.singleLimit, draft.attachments.count < 20,
              draft.attachments.reduce(data.count, { $0 + $1.size }) <= MailAttachment.totalLimit else {
            throw MailFailure.invalid("附件最多 20 个，单个 15 MB，合计 25 MB。")
        }
        var item = MailAttachment(name: name, mimeType: mimeType, data: data)
        item.localReference = UUID().uuidString
        try files.writeData(data, account: id, key: "attachment:" + item.localReference!)
        item.data = nil
        updateDraft { $0.attachments.append(item) }
    }
    private func hydrated(_ source: MailDraft, account: UUID) throws -> MailDraft {
        var next = source
        next.attachments = try source.attachments.map { item in
            var loaded = item
            if loaded.data == nil, let key = item.localReference { loaded.data = try files.readData(account: account, key: "attachment:" + key) }
            guard loaded.data != nil else { throw MailFailure.invalid("附件文件不可用，请重新添加。") }
            return loaded
        }
        return next
    }
    public func attachmentData(_ item: MailAttachment, summary: MailSummary? = nil) async throws -> Data {
        let entry = try credential()
        if let data = item.data { return data }
        let key = summary.map { "download:" + $0.id + ":" + item.id } ?? "attachment:" + (item.localReference ?? item.id)
        if let cached = try files.readData(account: entry.account.id, key: key) { return cached }
        guard let summary else { throw MailFailure.invalid("附件文件不可用。") }
        let data = try await service.attachment(entry, summary: summary, attachment: item)
        try Task.checkCancellation()
        guard data.count <= MailAttachment.singleLimit else { throw MailFailure.invalid("附件超过 15 MB 限制。") }
        try files.writeData(data, account: entry.account.id, key: key)
        return data
    }
    public func perform(_ action: MailAction, on items: [MailSummary]) async throws {
        guard !operating, !items.isEmpty else { return }
        let entry = try credential(); cancelRefresh(); operating = true
        defer { operating = false }
        clearUndo()
        var undo: [(MailAction, [MailSummary])] = []
        switch action {
        case .move(let target):
            if let moved = try await service.move(entry, summaries: items, to: target), let source = items.first?.folder {
                undo = [(.move(source), moved)]
            }
        case .read:
            try await service.perform(entry, summaries: items, action: action)
            for read in [true, false] {
                let previous = items.filter { !$0.unread == read }
                if !previous.isEmpty { undo.append((.read(read), previous)) }
            }
        case .flagged:
            try await service.perform(entry, summaries: items, action: action)
            for flagged in [true, false] {
                let previous = items.filter { ($0.isFlagged ?? false) == flagged }
                if !previous.isEmpty { undo.append((.flagged(flagged), previous)) }
            }
        }
        guard selectedID == entry.account.id else { return }
        let ids = Set(items.map(\.id))
        switch action {
        case .move: messages.removeAll { ids.contains($0.id) }
        case .read(let value): for index in messages.indices where ids.contains(messages[index].id) { messages[index].unread = !value }
        case .flagged(let value): for index in messages.indices where ids.contains(messages[index].id) { messages[index].isFlagged = value }
        }
        try files.write(messages, account: entry.account.id, key: "list:" + folder)
        if !undo.isEmpty {
            undoAccount = entry.account.id; undoActions = undo; undoExpiry = Date(timeIntervalSinceNow: 8)
            undoTitle = "邮件操作已完成"; undoID = UUID()
        }
    }
    public func clearUndo() { undoID = nil; undoActions = []; undoAccount = nil }
    public func undoLastAction() async throws {
        guard !operating, undoExpiry > Date(), undoAccount == selectedID, !undoActions.isEmpty else { clearUndo(); return }
        let entry = try credential(), actions = undoActions
        clearUndo(); cancelRefresh(); operating = true
        defer { operating = false; refresh() }
        for (action, items) in actions { try await service.perform(entry, summaries: items, action: action) }
    }
    public func search(_ query: String, limit: Int = 50) async throws -> [MailSummary] {
        let entry = try credential(), currentFolder = folder
        let result = try await service.search(entry, folder: currentFolder, query: query, limit: min(500, limit))
        try Task.checkCancellation()
        guard selectedID == entry.account.id, folder == currentFolder else { throw CancellationError() }
        searchTotal = result.total; return result.messages
    }
    public func retrySentCopy() async throws {
        guard draft.state == .sent, draft.sentCopyPending == true, !sending else { return }
        let entry = try credential(); sending = true; defer { sending = false }
        try await service.archiveSent(entry, draft: try hydrated(draft, account: entry.account.id))
        draft.sentCopyPending = false; try persistDraft()
    }
    public func updateAccount(_ input: MailAccount, password: String?) async throws {
        guard !sending else { throw MailFailure.invalid("请等待邮件发送完成。") }
        let account = try input.validated()
        guard let index = credentials.firstIndex(where: { $0.account.id == account.id }) else { throw MailFailure.missingPassword }
        guard !accounts.contains(where: { $0.id != account.id && $0.email.lowercased() == account.email.lowercased() }) else { throw MailFailure.invalid("此邮箱已经添加。") }
        let entry = AccountCredential(account: account, password: password?.isEmpty == false ? password! : credentials[index].password)
        try await service.validate(entry); try Task.checkCancellation()
        var next = credentials; next[index] = entry; try vault.save(next)
        credentials = next; accounts = next.map(\.account)
    }
    public func saveContact(_ contact: MailContact, replacingEmail: String? = nil) throws {
        guard let id = selectedID, MailValidation.isAddress(contact.email), !MailValidation.hasControl(contact.name), !MailValidation.hasControl(contact.note) else { throw MailFailure.invalid("请填写有效的联系人邮箱。") }
        var edited = contact; edited.manuallyEdited = true
        var updated = contacts.filter { $0.id != edited.id && $0.id != replacingEmail?.lowercased() }
        updated.append(edited)
        try files.write(updated, account: id, key: "contacts"); contacts = updated
    }
    private func learnContacts(_ addresses: [MailAddress], account id: UUID) throws {
        let original = selectedID == id ? contacts : (try files.read([MailContact].self, account: id, key: "contacts") ?? [])
        var updated = original
        let ownAddress = accounts.first { $0.id == id }?.email.lowercased()
        for address in addresses {
            let email = address.email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard MailValidation.isAddress(email), email.lowercased() != ownAddress else { continue }
            let name = MailAddress.cleanedName(address.name, email: email)
            if let index = updated.firstIndex(where: { $0.id == email.lowercased() }) {
                if !updated[index].manuallyEdited, MailAddress.cleanedName(updated[index].name, email: email).isEmpty, !name.isEmpty { updated[index].name = name }
            } else { updated.append(MailContact(email: email, name: name)) }
        }
        guard updated != original else { return }
        try files.write(updated, account: id, key: "contacts")
        if selectedID == id { contacts = updated }
    }
    public func cachedInbox() throws -> [LocatedMessage] {
        try accounts.flatMap { account in
            let list = try files.read([MailSummary].self, account: account.id, key: "list:INBOX") ?? []
            return list.map { LocatedMessage(accountID: account.id, summary: $0) }
        }.sorted { ($0.summary.date ?? .distantPast) > ($1.summary.date ?? .distantPast) }
    }
    public func refreshAllInboxes() async throws {
        cancelRefresh()
        for entry in credentials {
            try Task.checkCancellation()
            let result = try await service.summaries(entry, folder: "INBOX", limit: 50)
            try Task.checkCancellation()
            try files.write(result, account: entry.account.id, key: "list:INBOX")
            try learnContacts(result.flatMap(\.contactAddresses), account: entry.account.id)
            if selectedID == entry.account.id, folder == "INBOX" { messages = result; lastRefresh = Date() }
        }
    }
    public func removeSelectedAccount() throws {
        guard let id = selectedID else { return }
        try removeAccount(id)
    }
    public func removeAccount(_ id: UUID) throws {
        guard !sending, !operating else { throw MailFailure.invalid("请等待当前操作完成后再移除邮箱。") }
        guard accounts.contains(where: { $0.id == id }) else { return }
        let removingSelected = selectedID == id
        let updated = credentials.filter { $0.account.id != id }
        try vault.save(updated)
        if removingSelected { cancelRefresh() }
        credentials = updated; accounts = updated.map(\.account)
        try files.remove(account: id)
        guard removingSelected else { return }
        clearUndo()
        selectedID = nil; messages = []; folders = [.init(name: "INBOX")]; draft = MailDraft(); drafts = []; contacts = []
        if let first = accounts.first { try selectAccount(first.id); refresh() }
    }
}
