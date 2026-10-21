import Foundation

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
    public init(id: UUID = UUID()) { self.id = id }

    public mutating func suggestServers() {
        let domain = email.split(separator: "@").last.map(String.init)?.lowercased() ?? ""
        switch domain {
        case "qq.com", "foxmail.com": imapHost = "imap.qq.com"; smtpHost = "smtp.qq.com"
        case "163.com", "126.com": imapHost = "imap.\(domain)"; smtpHost = "smtp.\(domain)"
        case "icloud.com", "me.com", "mac.com":
            imapHost = "imap.mail.me.com"; smtpHost = "smtp.mail.me.com"
            smtpPort = 587; smtpSecurity = .startTLS
        default: imapHost = ""; smtpHost = ""
        }
        username = email.trimmingCharacters(in: .whitespacesAndNewlines)
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
        // SwiftMail's TLS adapter omits hostname validation for IP literals.
        // Require a DNS name so fullVerification always checks the configured server identity.
        guard !host.contains(":"), !host.allSatisfy({ $0.isNumber || $0 == "." }) else {
            throw MailFailure.invalid("请使用与服务器证书匹配的域名；内网 IP 请改用对应的内网域名。")
        }
    }
}

public struct MailFolder: Codable, Identifiable, Hashable, Sendable {
    public var name: String
    public var id: String { name }
    public var title: String { name.uppercased() == "INBOX" ? "收件箱" : name }
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
    public var id: String { "\(folder):\(validity):\(uid)" }
    public init(uid: UInt32, validity: UInt32, folder: String, subject: String, sender: String,
                replyAddress: String, date: Date?, unread: Bool, messageID: String? = nil) {
        self.uid = uid; self.validity = validity; self.folder = folder; self.subject = subject
        self.sender = sender; self.replyAddress = replyAddress; self.date = date; self.unread = unread
        self.messageID = messageID
    }
}

public struct MailBody: Codable, Sendable {
    public let text: String
    public let html: String?
    public init(text: String, html: String?) { self.text = text; self.html = html }
}

public enum SubmissionState: String, Codable, Sendable {
    case editing, submitting, uncertain, sent
}

public struct MailDraft: Codable, Equatable, Sendable {
    public var to = ""
    public var subject = ""
    public var text = ""
    public var inReplyTo: String?
    public var state: SubmissionState = .editing
    public init() {}
    public var isEmpty: Bool { to.isEmpty && subject.isEmpty && text.isEmpty }

    public func validateForSending() throws -> [String] {
        guard state == .editing else { throw MailFailure.uncertainSend }
        guard !MailValidation.hasControl(subject), subject.count <= 998 else {
            throw MailFailure.invalid("主题不能包含换行，长度不能超过 998 字符。")
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MailFailure.invalid("请先填写邮件正文。")
        }
        guard text.utf8.count <= 1_000_000 else { throw MailFailure.invalid("首版正文上限为 1 MB。") }
        return try MailValidation.recipients(to)
    }

    public mutating func recoverAfterInterruption() {
        if state == .submitting { state = .uncertain }
    }
}
