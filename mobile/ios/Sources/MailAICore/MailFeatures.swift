import Foundation

public struct MailAddress: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var name: String
    public var email: String
    public var id: String { email.lowercased() }
    public var title: String { name.isEmpty ? email : name }
    public init(name: String = "", email: String) { self.name = name; self.email = email }
    public static func cleanedName(_ value: String, email: String) -> String {
        var name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.count >= 2, name.first == "\"", name.last == "\"" { name = String(name.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !MailValidation.hasControl(name), name.caseInsensitiveCompare(email) != .orderedSame,
              name.range(of: "=\\?[^?\\s]+\\?[bBqQ]\\?[^?]*\\?=", options: .regularExpression) == nil else { return "" }
        return String(name.prefix(200))
    }
}
public struct MailRecipients: Equatable, Sendable {
    public var to: [String]; public var cc: [String]; public var bcc: [String]
}
public struct MailAttachment: Codable, Equatable, Identifiable, Sendable {
    public static let singleLimit = 15_000_000
    public static let totalLimit = 25_000_000
    public var id: String
    public var name: String
    public var mimeType: String
    public var size: Int
    public var data: Data?
    public var localReference: String?
    public init(id: String = UUID().uuidString, name: String, mimeType: String = "application/octet-stream", size: Int = 0, data: Data? = nil) {
        self.id = id; self.name = Self.safeName(name); self.mimeType = mimeType; self.size = data?.count ?? size; self.data = data
    }
    public static func safeName(_ name: String) -> String {
        let clean = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? "附件"
        let filtered = clean.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let value = String(String.UnicodeScalarView(filtered)).prefix(160)
        return value.isEmpty || value == "." || value == ".." ? "附件" : String(value)
    }
}
public struct MailContact: Codable, Equatable, Identifiable, Sendable {
    public var email: String
    public var name: String
    public var note: String
    public var manuallyEdited: Bool
    public var id: String { email.lowercased() }
    public var title: String { !note.isEmpty ? note : (!name.isEmpty ? name : email) }
    public init(email: String, name: String = "", note: String = "", manuallyEdited: Bool = false) {
        self.email = email; self.name = name; self.note = note; self.manuallyEdited = manuallyEdited
    }
}
public enum MailAction: Sendable, Equatable {
    case read(Bool), flagged(Bool), move(String)
}
public enum DraftMode: Sendable { case reply, replyAll, forward }
public struct LocatedMessage: Identifiable, Sendable {
    public let accountID: UUID
    public var summary: MailSummary
    public var id: String { accountID.uuidString + ":" + summary.id }
    public init(accountID: UUID, summary: MailSummary) { self.accountID = accountID; self.summary = summary }
}
public struct MailSearchResult: Sendable {
    public var messages: [MailSummary]
    public var total: Int
    public init(messages: [MailSummary], total: Int) { self.messages = messages; self.total = total }
}

/// Uses actual Message-ID / reply references; equal subjects alone never merge mail.
public struct MailThread: Identifiable, Sendable {
    public let id: String
    public var messages: [MailSummary]
    public static func group(_ items: [MailSummary]) -> [MailThread] {
        var roots: [String: String] = [:]
        func root(_ key: String) -> String {
            var result = key
            while let parent = roots[result], parent != result { result = parent }
            return result
        }
        let pattern = try? NSRegularExpression(pattern: "<[^>]{1,998}>")
        var keys: [String: String] = [:]
        for item in items {
            let combined = [item.messageID, item.parentMessageID, item.references].compactMap { $0 }.joined(separator: " ")
            let matches = pattern?.matches(in: combined, range: NSRange(combined.startIndex..., in: combined)) ?? []
            let identifiers = matches.compactMap { Range($0.range, in: combined).map { String(combined[$0]) } }
            let first = identifiers.first ?? "local:" + item.id
            if roots[first] == nil { roots[first] = first }
            for identifier in identifiers {
                if roots[identifier] == nil { roots[identifier] = identifier }
                let source = root(identifier), target = root(first)
                if source != target { roots[source] = target }
            }
            keys[item.id] = first
        }
        let grouped = Dictionary(grouping: items) { root(keys[$0.id] ?? "local:" + $0.id) }
        return grouped.map { MailThread(id: $0.key, messages: $0.value.sorted { $0.uid > $1.uid }) }
            .sorted { ($0.messages.first?.date ?? .distantPast) > ($1.messages.first?.date ?? .distantPast) }
    }
}
