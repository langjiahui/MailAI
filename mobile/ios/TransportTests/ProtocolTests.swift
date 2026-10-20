import XCTest
import MailAICore
@testable import MailAI

final class ProtocolTests: XCTestCase {
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
        let folders = try await service.folders(entry); XCTAssertEqual(folders.map(\.name), ["INBOX"])
        let messages = try await service.summaries(entry, folder: "INBOX", limit: 50)
        XCTAssertEqual(messages.count, 1); XCTAssertEqual(messages.first?.uid, 7)
        XCTAssertEqual(messages.first?.validity, 10); XCTAssertEqual(messages.first?.replyAddress, "sender@example.com")
        let result = try await service.read(entry, summary: XCTUnwrap(messages.first))
        XCTAssertTrue(result.body.text.contains("Synthetic offline message")); XCTAssertTrue(result.markedRead)
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
