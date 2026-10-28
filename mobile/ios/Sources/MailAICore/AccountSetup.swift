import Foundation

/// Local, exact-domain presets. Resolving a preset never performs network requests.
public struct MailProvider: Equatable, Sendable {
    public let title: String
    public let imapHost: String
    public let smtpHost: String
    public var smtpPort = 465
    public var smtpSecurity: TransportSecurity = .tls
    public let passwordHint: String

    public static func match(email: String) -> MailProvider? {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MailValidation.isAddress(address), let domain = address.split(separator: "@").last?.lowercased() else { return nil }
        switch domain {
        case "qq.com", "foxmail.com":
            return MailProvider(title: domain == "qq.com" ? "QQ 邮箱" : "Foxmail 邮箱",
                imapHost: "imap.qq.com", smtpHost: "smtp.qq.com",
                passwordHint: "请在 QQ 邮箱网页版开启 IMAP/SMTP 服务，并使用生成的授权码。")
        case "163.com", "126.com", "yeah.net":
            return MailProvider(title: domain == "yeah.net" ? "yeah 邮箱" : "\(domain == "163.com" ? "163" : "126") 邮箱",
                imapHost: "imap.\(domain)", smtpHost: "smtp.\(domain)",
                passwordHint: "请在邮箱网页版开启 IMAP/SMTP 服务，并使用客户端授权码。")
        case "icloud.com", "me.com", "mac.com":
            return MailProvider(title: "iCloud 邮箱", imapHost: "imap.mail.me.com", smtpHost: "smtp.mail.me.com",
                smtpPort: 587, smtpSecurity: .startTLS, passwordHint: "请使用 Apple 账户生成的 App 专用密码。")
        case "gmail.com", "googlemail.com":
            return MailProvider(title: "Gmail", imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com",
                passwordHint: "请使用开启两步验证后生成的应用专用密码。当前 iOS 版暂不支持 Google 网页授权登录。")
        case "outlook.com", "hotmail.com", "live.com", "office365.com":
            return MailProvider(title: "Outlook / Microsoft 365", imapHost: "outlook.office365.com", smtpHost: "smtp.office365.com",
                smtpPort: 587, smtpSecurity: .startTLS,
                passwordHint: "这类邮箱可能仅允许官方授权登录。当前 iOS 版暂不支持 Microsoft 网页授权；若服务商禁用密码登录，填写服务器也无法连接。")
        case "yahoo.com":
            return MailProvider(title: "Yahoo 邮箱", imapHost: "imap.mail.yahoo.com", smtpHost: "smtp.mail.yahoo.com",
                passwordHint: "请使用邮箱服务商提供的客户端应用密码。")
        case "aliyun.com", "sina.com", "sohu.com", "139.com":
            return MailProvider(title: "\(domain) 邮箱", imapHost: "imap.\(domain)", smtpHost: "smtp.\(domain)",
                passwordHint: "请开启 IMAP/SMTP 服务，并按邮箱服务商要求使用密码或客户端授权码。")
        default: return nil
        }
    }
}

/// State transitions for the add-account form, separate from saved accounts.
public struct AccountSetup: Sendable {
    public private(set) var account = MailAccount()
    public private(set) var manualServers = false
    public var provider: MailProvider? { MailProvider.match(email: account.email) }
    public static func suggestedDomain(email: String) -> String? {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MailValidation.isAddress(address), let domain = address.split(separator: "@").last?.lowercased(),
              domain.count <= 190, domain.split(separator: ".").allSatisfy({ !$0.isEmpty && $0.count <= 63 }),
              domain.range(of: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$", options: .regularExpression) != nil else { return nil }
        return domain
    }
    public init() {}
    public init(account: MailAccount) { self.account = account; manualServers = true }

    public mutating func updateEmail(_ email: String) {
        let old = account.email.trimmingCharacters(in: .whitespacesAndNewlines)
        let new = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let oldDomain = old.split(separator: "@", omittingEmptySubsequences: false).last?.lowercased()
        let newDomain = new.split(separator: "@", omittingEmptySubsequences: false).last?.lowercased()
        account.email = email
        if old != new { account.username = new }
        // Never carry an old provider's endpoints to a different domain.
        if oldDomain != newDomain { manualServers = false }
        if !manualServers {
            let username = account.username
            account.suggestServers()
            account.username = username
        }
    }

    public mutating func set<Value>(_ keyPath: WritableKeyPath<MailAccount, Value>, _ value: Value) {
        account[keyPath: keyPath] = value
    }
    public mutating func setServer<Value>(_ keyPath: WritableKeyPath<MailAccount, Value>, _ value: Value) {
        manualServers = true
        account[keyPath: keyPath] = value
    }
    public mutating func restoreAutomaticServers() {
        manualServers = false
        let username = account.username
        account.suggestServers()
        account.username = username
    }
    public func preparedAccount() throws -> MailAccount {
        return try account.validated()
    }
}
