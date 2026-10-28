import Foundation

public struct MailAddress: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var name: String
    public var email: String
    public var id: String { email.lowercased() }
    public var title: String { name.isEmpty ? email : name }
    public init(name: String = "", email: String) { self.name = name; self.email = email }
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
