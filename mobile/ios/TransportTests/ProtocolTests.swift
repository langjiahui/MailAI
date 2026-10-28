import XCTest
import MailAICore
import Security
@testable import MailAI

final class ProtocolTests: XCTestCase {
    @MainActor func testSystemKeychainRoundTripOnSignedSimulator() throws {
        let service = "com.mailai.ios.tests." + UUID().uuidString
        let vault = KeychainVault(service: service)
        defer { SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary) }
        XCTAssertTrue(try vault.load().isEmpty)
        let entry = credential()
        try vault.save([entry])
        let restored = try vault.load()
        XCTAssertEqual(restored.first?.account, entry.account)
        XCTAssertEqual(restored.first?.password, "synthetic-password")
        try vault.save([])
        XCTAssertTrue(try vault.load().isEmpty)
    }
    private func credential() -> AccountCredential {
        var account = MailAccount(); account.email = "demo@example.com"; account.username = account.email
        account.imapHost = "localhost"; account.imapPort = 1993
        account.smtpHost = "localhost"; account.smtpPort = 1465
        // Deliberate test-only loopback fixture; production account validation rejects localhost.
        return AccountCredential(account: account, password: "synthetic-password")
    }
    func testTLSIMAPLoginFoldersHeadersAndReading() async throws {
        let service = NativeMailService(); let entry = credential()
        try await service.validate(entry)
        let folders = try await service.folders(entry); XCTAssertEqual(Set(folders.map(\.name)), Set(["INBOX", "Sent", "Archive"]))
        let messages = try await service.summaries(entry, folder: "INBOX", limit: 50)
        XCTAssertEqual(messages.count, 1); XCTAssertEqual(messages.first?.uid, 7)
        XCTAssertEqual(messages.first?.validity, 10); XCTAssertEqual(messages.first?.replyAddress, "sender@example.com")
        let result = try await service.read(entry, summary: XCTUnwrap(messages.first))
        XCTAssertTrue(result.body.text.contains("Synthetic offline message")); XCTAssertTrue(result.markedRead)
    }
    func testAttachmentsServerSearchFlagsMoveAndSentArchive() async throws {
        let service = NativeMailService(); var entry = credential(); entry.account.sentFolder = "Sent"
        let messages = try await service.summaries(entry, folder: "INBOX", limit: 50)
        let message = try XCTUnwrap(messages.first)
        XCTAssertEqual(message.hasAttachments, true)
        let result = try await service.read(entry, summary: message)
        let item = try XCTUnwrap(result.body.attachments?.first)
        XCTAssertEqual(item.name, "synthetic.txt")
        let bytes = try await service.attachment(entry, summary: message, attachment: item)
        XCTAssertEqual(bytes, Data("synthetic attachment".utf8))
        let found = try await service.search(entry, folder: "INBOX", query: "synthetic", limit: 50)
        XCTAssertEqual(found.total, 1); XCTAssertEqual(found.messages.first?.uid, 7)
        try await service.perform(entry, summaries: [message], action: .flagged(true))
        try await service.perform(entry, summaries: [message], action: .read(false))
        try await service.perform(entry, summaries: [message], action: .move("Archive"))
        var draft = MailDraft(); draft.to = "recipient@example.com"; draft.cc = "copy@example.com"; draft.bcc = "blind@example.com"
        draft.subject = "synthetic cc bcc"; draft.text = "synthetic attachment submission"
        draft.attachments = [.init(name: "synthetic.txt", mimeType: "text/plain", data: bytes)]
        try await service.send(entry, draft: draft)
        try await service.archiveSent(entry, draft: draft)
        // Same stable Message-ID must be found rather than APPENDed a second time.
        try await service.archiveSent(entry, draft: draft)
    }
    func testModelClientUsesHTTPSRejectsRedirectsAndIncompleteResults() async throws {
        var configuration = AssistantConfiguration(); configuration.endpoint = "https://localhost:18443/v1"
        configuration.model = "fixture"; configuration.key = "fixture"; configuration.consent = true
        let output = try await AssistantAPI.generate(configuration: configuration, instruction: "synthetic", text: "synthetic")
        XCTAssertEqual(output, "synthetic model response")
        for path in ["redirect", "incomplete"] {
            configuration.endpoint = "https://localhost:18443/" + path
            do { _ = try await AssistantAPI.generate(configuration: configuration, instruction: "synthetic", text: "synthetic"); XCTFail("Must reject redirected or incomplete response") }
            catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        }
        configuration.endpoint = "http://localhost:18443/v1"; XCTAssertThrowsError(try configuration.url())
        configuration.endpoint = "https://user:password@example.test/v1"; XCTAssertThrowsError(try configuration.url())
        configuration.endpoint = "https://example.test/v1"; configuration.consent = false; XCTAssertThrowsError(try configuration.url())
    }
    func testSMTPAcceptsSyntheticMessage() async throws {
        var draft = MailDraft(); draft.to = "recipient@example.com"; draft.subject = "synthetic 测试"; draft.text = "synthetic 中文正文"
        try await NativeMailService().send(credential(), draft: draft)
    }
    func testSMTPDisconnectAfterDataIsUnsafeToRetry() async throws {
        var draft = MailDraft(); draft.to = "uncertain@example.com"; draft.subject = "synthetic"; draft.text = "synthetic unknown acceptance"
        do { try await NativeMailService().send(credential(), draft: draft); XCTFail("Expected uncertain acceptance") }
        catch let error as SubmissionFailure { XCTAssertTrue(error.uncertain) }
    }
}
