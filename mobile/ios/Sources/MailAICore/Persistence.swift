import Foundation
import Security
import CryptoKit

public struct AccountCredential: Codable, Sendable {
    public var account: MailAccount
    public var password: String
    public init(account: MailAccount, password: String) { self.account = account; self.password = password }
}

@MainActor public protocol CredentialStorage {
    func load() throws -> [AccountCredential]
    func save(_ credentials: [AccountCredential]) throws
}

@MainActor public final class KeychainVault: CredentialStorage {
    private let service: String
    public init(service: String = "com.mailai.ios.accounts.v1") { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "accounts"]
    }
    public func load() throws -> [AccountCredential] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw keychainError(status) }
        return try JSONDecoder().decode([AccountCredential].self, from: data)
    }
    public func save(_ credentials: [AccountCredential]) throws {
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credentials),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw keychainError(status) }
    }
    private func keychainError(_ status: OSStatus) -> Error {
        let message = status == errSecMissingEntitlement
            ? "应用签名缺少钥匙串权限，请使用匹配的证书和描述文件重新签名安装。"
            : "钥匙串暂时不可用，请解锁设备后重试。"
        return NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [
            NSLocalizedDescriptionKey: message
        ])
    }
}

/// Private on-device cache. Credentials never pass through this class.
public final class MailFiles {
    private let root: URL
    public init(root: URL? = nil) throws {
        self.root = try root ?? FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("MailAI", isDirectory: true)
        try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        var url = self.root
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    private func url(account: UUID, key: String) throws -> URL {
        let directory = root.appendingPathComponent(account.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest + ".json")
    }
    public func read<T: Decodable>(_ type: T.Type, account: UUID, key: String) throws -> T? {
        let path = try url(account: account, key: key)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: path))
    }
    public func write<T: Encodable>(_ value: T, account: UUID, key: String) throws {
        let data = try JSONEncoder().encode(value)
        #if os(iOS)
        try data.write(to: url(account: account, key: key), options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url(account: account, key: key), options: .atomic)
        #endif
    }
    public func writeData(_ data: Data, account: UUID, key: String) throws {
        #if os(iOS)
        try data.write(to: url(account: account, key: key).appendingPathExtension("bin"), options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url(account: account, key: key).appendingPathExtension("bin"), options: .atomic)
        #endif
    }
    public func readData(account: UUID, key: String) throws -> Data? {
        let path = try url(account: account, key: key).appendingPathExtension("bin")
        return FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil
    }
    public func remove(account: UUID) throws {
        let directory = root.appendingPathComponent(account.uuidString)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
