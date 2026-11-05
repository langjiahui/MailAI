import Foundation

public struct MailNotificationTarget: Codable, Equatable, Sendable {
    public let accountID: UUID
    public let uid: UInt32
    public let validity: UInt32
    public init(accountID: UUID, uid: UInt32, validity: UInt32) { self.accountID = accountID; self.uid = uid; self.validity = validity }
    public var identifier: String { "mail." + accountID.uuidString + ".\(validity).\(uid)" }
}
public struct MailNotice: Codable, Equatable, Sendable {
    public let target: MailNotificationTarget
    public var sender: String?
    public var subject: String?
    public init(accountID: UUID, summary: MailSummary, preview: Bool) {
        target = .init(accountID: accountID, uid: summary.uid, validity: summary.validity)
        sender = preview ? summary.senderName ?? summary.sender : nil
        subject = preview ? summary.subject : nil
    }
}
public struct MailNotificationLedger: Codable, Sendable {
    public struct Cursor: Codable, Equatable, Sendable { public var validity: UInt32?; public var uid: UInt32 }
    public private(set) var cursors: [UUID: Cursor] = [:]
    public private(set) var pending: [MailNotice] = []
    public init() {}
    public mutating func retainAccounts(_ ids: Set<UUID>) { cursors = cursors.filter { ids.contains($0.key) }; pending.removeAll { !ids.contains($0.target.accountID) } }
    public mutating func hidePreviews() { for i in pending.indices { pending[i].sender = nil; pending[i].subject = nil } }
    public mutating func observe(account: UUID, messages: [MailSummary], permitted: Bool, preview: Bool) throws {
        guard messages.allSatisfy({ $0.folder == "INBOX" && $0.uid > 0 }), Set(messages.map(\.validity)).count <= 1 else { throw MailFailure.changedMailbox }
        let newest = messages.max { $0.uid < $1.uid }
        let previous = cursors[account]
        // Empty first checks still establish a baseline; later first mail must alert.
        guard let newest else { if previous == nil { cursors[account] = Cursor(validity: nil, uid: 0) }; if !permitted { pending.removeAll { $0.target.accountID == account } }; return }
        let changed = previous?.validity != nil && previous?.validity != newest.validity
        if changed || !permitted { pending.removeAll { $0.target.accountID == account } }
        if let previous, !changed, permitted {
            var seen = Set(pending.map { $0.target.identifier })
            for item in messages.filter({ $0.uid > previous.uid && $0.unread }).sorted(by: { $0.uid < $1.uid }) {
                let notice = MailNotice(accountID: account, summary: item, preview: preview)
                if seen.insert(notice.target.identifier).inserted { pending.append(notice) }
            }
        }
        // A truncated/stale response cannot move the cursor backwards.
        cursors[account] = Cursor(validity: newest.validity, uid: changed ? newest.uid : max(previous?.uid ?? 0, newest.uid))
        if !preview { hidePreviews() }
    }
    public mutating func acknowledge(_ notices: [MailNotice]) { let ids = Set(notices.map { $0.target.identifier }); pending.removeAll { ids.contains($0.target.identifier) } }
}

/// Contains only notification cursors and opt-in preview text, never credentials,
/// mail bodies, attachments or drafts. The main MailFiles protection is unchanged.
public final class MailNotificationFile {
    public let url: URL
    public init(root: URL? = nil) throws {
        let root = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("MailAI-Notifications", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var directory = root; var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        #endif
        url = root.appendingPathComponent("state.json")
    }
    public func load() throws -> MailNotificationLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return MailNotificationLedger() }
        return try JSONDecoder().decode(MailNotificationLedger.self, from: Data(contentsOf: url))
    }
    public func save(_ ledger: MailNotificationLedger) throws {
        let data = try JSONEncoder().encode(ledger)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
    public func remove() throws { if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) } }
}

@MainActor public enum MailNotificationCheck {
    public struct Result: Sendable {
        public var checkedAccounts = 0
        public var failedAccounts = 0
        public var submittedMessages = 0
        public var deliveryFailures = 0
    }
    public static func run(credentials: [AccountCredential], service: any MailService, file: MailNotificationFile, permitted: Bool, preview: Bool,
                           deliver: @MainActor ([MailNotice]) async throws -> Void) async throws -> Result {
        var ledger = try file.load(), result = Result()
        ledger.retainAccounts(Set(credentials.map { $0.account.id }))
        if !preview { ledger.hidePreviews() }
        if !permitted { ledger.acknowledge(ledger.pending) }
        try file.save(ledger)
        for entry in credentials {
            try Task.checkCancellation()
            let messages: [MailSummary]
            do { messages = try await service.summaries(entry, folder: "INBOX", limit: 200) }
            catch { try Task.checkCancellation(); result.failedAccounts += 1; continue }
            try Task.checkCancellation()
            try ledger.observe(account: entry.account.id, messages: messages, permitted: permitted, preview: preview)
            // Fail closed if durable storage fails; never deliver an unpersisted queue.
            try file.save(ledger); result.checkedAccounts += 1
        }
        if permitted {
            for account in Set(ledger.pending.map { $0.target.accountID }).sorted(by: { $0.uuidString < $1.uuidString }) {
                try Task.checkCancellation()
                let batch = ledger.pending.filter { $0.target.accountID == account }
                do {
                    try await deliver(batch); try Task.checkCancellation()
                    ledger.acknowledge(batch); try file.save(ledger); result.submittedMessages += batch.count
                } catch { try Task.checkCancellation(); result.deliveryFailures += 1 }
            }
        }
        return result
    }
}
