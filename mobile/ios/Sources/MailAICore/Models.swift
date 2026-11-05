import Foundation
import Darwin

public enum MailFailure: LocalizedError, Equatable {
    case invalid(String)
    case missingPassword
    case changedMailbox
    case uncertainSend

    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .missingPassword: return "无法读取邮箱凭据，请重新添加账号。"
        case .changedMailbox: return "服务器文件夹已重建，请刷新列表后重新打开邮件。"
        case .uncertainSend: return "发送结果待确认。请先查看收件方或服务器已发送邮件，确认未送达后才能再次发送。"
        }
    }
}

public enum TransportSecurity: String, Codable, CaseIterable, Identifiable, Sendable {
    case tls, startTLS
    public var id: String { rawValue }
    public var title: String { self == .tls ? "SSL / TLS" : "STARTTLS（强制加密）" }
}

public struct MailAccount: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var email = ""
    public var displayName = ""
    public var username = ""
    public var imapHost = ""
    public var imapPort = 993
    public var imapSecurity: TransportSecurity = .tls
    public var smtpHost = ""
    public var smtpPort = 465
    public var smtpSecurity: TransportSecurity = .tls
    public var signature: String?
    public var sentFolder: String?
    public var archiveFolder: String?
    public var trashFolder: String?
    public var saveSentCopy: Bool?
    public var shouldSaveSentCopy: Bool {
        saveSentCopy ?? !["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "office365.com"].contains(email.split(separator: "@").last?.lowercased() ?? "")
    }
    public init(id: UUID = UUID()) { self.id = id }

    public mutating func suggestServers() {
        username = email.trimmingCharacters(in: .whitespacesAndNewlines)
        imapPort = 993; imapSecurity = .tls; smtpPort = 465; smtpSecurity = .tls
        let provider = MailProvider.match(email: email)
        let domain = AccountSetup.suggestedDomain(email: email)
        imapHost = provider?.imapHost ?? domain.map { "imap.\($0)" } ?? ""
        smtpHost = provider?.smtpHost ?? domain.map { "smtp.\($0)" } ?? ""
        if let provider { smtpPort = provider.smtpPort; smtpSecurity = provider.smtpSecurity }
    }

    public func validated() throws -> Self {
        var result = self
        result.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        result.username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        result.imapHost = imapHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        result.smtpHost = smtpHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard MailValidation.isAddress(result.email), !result.username.isEmpty,
              !MailValidation.hasControl(result.username), !MailValidation.hasControl(displayName) else {
            throw MailFailure.invalid("请填写完整邮箱地址、登录用户名和有效显示名称。")
        }
        for host in [result.imapHost, result.smtpHost] {
            try MailValidation.validateHost(host)
        }
        guard (1...65535).contains(imapPort), (1...65535).contains(smtpPort) else {
            throw MailFailure.invalid("端口必须在 1 到 65535 之间。")
        }
        return result
    }
}

public enum MailValidation {
    public static func hasControl(_ value: String) -> Bool {
        value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    public static func isAddress(_ value: String) -> Bool {
        guard !hasControl(value), value.count <= 254 else { return false }
        let pieces = value.split(separator: "@", omittingEmptySubsequences: false)
        return pieces.count == 2 && !pieces[0].isEmpty && pieces[1].contains(".") &&
            !value.contains(where: { $0.isWhitespace || "<>,;\"".contains($0) })
    }

    public static func recipients(_ value: String) throws -> [String] {
        guard !hasControl(value) else { throw MailFailure.invalid("收件地址不能包含换行。") }
        let parts = value.split(whereSeparator: { ",;，；".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard !parts.isEmpty, parts.count <= 50, parts.allSatisfy(isAddress) else {
            throw MailFailure.invalid("请输入完整邮箱地址，以逗号分隔；最多 50 位收件人。")
        }
        var seen = Set<String>()
        return parts.filter { seen.insert($0.lowercased()).inserted }
    }

    public static func validateHost(_ host: String) throws {
        guard !host.isEmpty, !hasControl(host), !host.contains(where: { $0.isWhitespace }),
              !host.contains(where: { "/\\@?#%[]".contains($0) }),
              host != "localhost", !host.hasSuffix(".localhost"),
              !host.hasPrefix("127."), !host.hasPrefix("169.254."),
              !["0.0.0.0", "::", "::1"].contains(host),
              !host.lowercased().hasPrefix("fe80:") else {
            throw MailFailure.invalid("请填写邮箱服务器域名，不能使用网址、回环或链路本地地址。")
        }
        // NIOSSL fullVerification checks an IP literal against the peer's IP SAN,
        // even when SNI is omitted. User-configured private mail endpoints are valid.
        var v4 = in_addr()
        if inet_pton(AF_INET, host, &v4) == 1 {
            let bytes = withUnsafeBytes(of: v4) { Array($0) }
            guard (1...223).contains(bytes[0]), bytes[0] != 127,
                  !(bytes[0] == 169 && bytes[1] == 254) else {
                throw MailFailure.invalid("邮箱服务器不能使用回环、链路本地、组播或未指定地址。")
            }
            return
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, host, &v6) == 1 {
            let bytes = withUnsafeBytes(of: v6) { Array($0) }
            guard bytes[0] & 0xe0 == 0x20 || bytes[0] & 0xfe == 0xfc else {
                throw MailFailure.invalid("请使用公网或公司内网 IPv6 地址，不能使用回环、链路本地或映射地址。")
            }
            return
        }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard host.utf8.count <= 253, !host.contains(":"),
              !host.allSatisfy({ $0.isNumber || $0 == "." }),
              labels.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 63 &&
                  $0.first != "-" && $0.last != "-" &&
                  $0.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 } }) else {
            throw MailFailure.invalid("请填写有效的邮箱服务器域名或 IP 地址，不包含端口或网址。")
        }
    }
}

public struct MailFolder: Codable, Identifiable, Hashable, Sendable {
    public var name: String
    public var id: String { name }
    public var role: String?
    public var title: String {
        let value = role ?? name.lowercased().split(separator: "/").last.map(String.init) ?? name.lowercased()
        switch value {
        case "inbox": return "收件箱"
        case "sent", "sent messages", "sent items", "已发送邮件", "已发送的邮件": return "已发送"
        case "drafts", "draft", "草稿箱": return "草稿"
        case "trash", "deleted", "deleted messages", "deleted items", "已删除邮件", "已删除的邮件", "已删除项目", "已删除": return "废纸篓"
        case "archive", "archives", "all mail": return "归档"
        case "junk", "spam": return "垃圾邮件"
        default: return name
        }
    }
    public var symbol: String {
        switch title { case "收件箱": return "tray"; case "已发送": return "paperplane"; case "草稿": return "doc"; case "废纸篓": return "trash"; case "归档": return "archivebox"; case "垃圾邮件": return "exclamationmark.shield"; default: return "folder" }
    }
    public init(name: String) { self.name = name }
}

public struct MailSummary: Codable, Identifiable, Equatable, Sendable {
    public let uid: UInt32
    public let validity: UInt32
    public let folder: String
    public var subject: String
    public var sender: String
    public var replyAddress: String
    public var date: Date?
    public var unread: Bool
    public var messageID: String?
    public var recipients: [MailAddress]?
    public var carbonCopies: [MailAddress]?
    public var isFlagged: Bool?
    public var hasAttachments: Bool?
    public var preview: String?
    public var senderName: String?
    public var senderAddress: String?
    public var references: String?
    public var parentMessageID: String?
    public var threadKey: String {
        subject.replacingOccurrences(of: "^(?:(?:re|fw|fwd|回复|转发)\\s*[:：]\\s*)+", with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
    public var id: String { "\(folder):\(validity):\(uid)" }
    public func relocated(uid: UInt32, validity: UInt32, folder: String) -> MailSummary {
        var next = MailSummary(uid: uid, validity: validity, folder: folder, subject: subject, sender: sender, replyAddress: replyAddress, date: date, unread: unread, messageID: messageID)
        next.recipients = recipients; next.carbonCopies = carbonCopies; next.isFlagged = isFlagged
        next.hasAttachments = hasAttachments; next.preview = preview; next.senderName = senderName; next.senderAddress = senderAddress
        next.references = references; next.parentMessageID = parentMessageID; return next
    }
    public init(uid: UInt32, validity: UInt32, folder: String, subject: String, sender: String,
                replyAddress: String, date: Date?, unread: Bool, messageID: String? = nil) {
        self.uid = uid; self.validity = validity; self.folder = folder; self.subject = subject
        self.sender = sender; self.replyAddress = replyAddress; self.date = date; self.unread = unread
        self.messageID = messageID
    }
    public var contactAddresses: [MailAddress] {
        let raw = sender.trimmingCharacters(in: .whitespacesAndNewlines)
        let left = raw.lastIndex(of: "<"), right = raw.lastIndex(of: ">")
        let headerAddress: String? = {
            if let left, let right, left < right { return String(raw[raw.index(after: left)..<right]) }
            return MailValidation.isAddress(raw) ? raw : nil
        }()
        let address = senderAddress ?? headerAddress ?? replyAddress
        let headerName = left.map { String(raw[..<$0]) } ?? (MailValidation.isAddress(raw) ? "" : raw)
        let structuredName = MailAddress.cleanedName(senderName ?? "", email: address)
        let name = structuredName.isEmpty ? MailAddress.cleanedName(headerName, email: address) : structuredName
        var result = [MailAddress(name: name, email: address)]
        if replyAddress.caseInsensitiveCompare(address) != .orderedSame { result.append(MailAddress(email: replyAddress)) }
        return result + (recipients ?? []) + (carbonCopies ?? [])
    }
    public func correspondent(ownAddress: String) -> String {
        let sender = contactAddresses.first?.email ?? replyAddress
        if sender.caseInsensitiveCompare(ownAddress) != .orderedSame { return sender }
        return ((recipients ?? []) + (carbonCopies ?? [])).first {
            MailValidation.isAddress($0.email) && $0.email.caseInsensitiveCompare(ownAddress) != .orderedSame
        }?.email ?? sender
    }
    public func involves(_ address: String) -> Bool {
        let target = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard MailValidation.isAddress(target) else { return false }
        let sender = contactAddresses.first?.email ?? ""
        return ([sender] + (recipients ?? []).map(\.email) + (carbonCopies ?? []).map(\.email))
            .contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == target }
    }
}

public struct MailBody: Codable, Sendable {
    public let text: String
    public let html: String?
    public var attachments: [MailAttachment]?
    public var recipients: [MailAddress]?
    public var carbonCopies: [MailAddress]?
    public init(text: String, html: String?, attachments: [MailAttachment] = [], recipients: [MailAddress] = [], carbonCopies: [MailAddress] = []) {
        self.text = text; self.html = html; self.attachments = attachments; self.recipients = recipients; self.carbonCopies = carbonCopies
    }
}

public enum SubmissionState: String, Codable, Sendable {
    case editing, submitting, uncertain, sent
}

public struct MailDraft: Codable, Equatable, Identifiable, Sendable {
    public var identifier: String? = UUID().uuidString
    public var id: String { identifier ?? "legacy" }
    public var updatedAt: Date?
    public var ccValue: String?
    public var bccValue: String?
    public var cc: String { get { ccValue ?? "" } set { ccValue = newValue } }
    public var bcc: String { get { bccValue ?? "" } set { bccValue = newValue } }
    public var attachmentItems: [MailAttachment]?
    public var attachments: [MailAttachment] { get { attachmentItems ?? [] } set { attachmentItems = newValue } }
    public var html: String?
    public var sentCopyPending: Bool?
    public var to = ""
    public var subject = ""
    public var text = ""
    public var inReplyTo: String?
    public var state: SubmissionState = .editing
    public init() {}
    public var isEmpty: Bool { to.isEmpty && cc.isEmpty && bcc.isEmpty && subject.isEmpty && text.isEmpty && attachments.isEmpty }

    public func validateForSending() throws -> [String] {
        guard state == .editing else { throw MailFailure.uncertainSend }
        guard !MailValidation.hasControl(subject), subject.count <= 998 else {
            throw MailFailure.invalid("主题不能包含换行，长度不能超过 998 字符。")
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else {
            throw MailFailure.invalid("请先填写邮件正文。")
        }
        guard text.utf8.count <= 1_000_000 else { throw MailFailure.invalid("首版正文上限为 1 MB。") }
        let groups = try recipientGroups()
        guard attachments.count <= 20, attachments.reduce(0, { $0 + ($1.data?.count ?? $1.size) }) <= MailAttachment.totalLimit,
              attachments.allSatisfy({ ($0.data != nil || $0.localReference != nil) && ($0.data?.count ?? $0.size) <= MailAttachment.singleLimit }) else {
            throw MailFailure.invalid("附件最多 20 个、单个 15 MB、合计 25 MB，请检查附件是否完整。")
        }
        return groups.to
    }
    public func recipientGroups() throws -> MailRecipients {
        var seen = Set<String>()
        func parse(_ value: String) throws -> [String] {
            if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
            return try MailValidation.recipients(value).filter { seen.insert($0.lowercased()).inserted }
        }
        let primary = try parse(to), copies = try parse(cc), blind = try parse(bcc)
        guard !primary.isEmpty, primary.count + copies.count + blind.count <= 50 else {
            throw MailFailure.invalid("请填写至少一位收件人；收件人、抄送和密送合计最多 50 位。")
        }
        return MailRecipients(to: primary, cc: copies, bcc: blind)
    }

    public mutating func recoverAfterInterruption() {
        if state == .submitting { state = .uncertain }
    }
}
