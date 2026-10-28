import XCTest
import MailAICore
import Security
import UIKit
@testable import MailAI

final class ProtocolTests: XCTestCase {
    @MainActor func testComposerFormattingPreservesTextAndEscapesHTML() {
        let view = UITextView()
        view.attributedText = NSAttributedString(string: "A<B & C", attributes: [.font: UIFont.systemFont(ofSize: 17)])
        view.selectedRange = NSRange(location: 0, length: 3)
        let commands = ComposerEditorCommands(); commands.view = view
        var outputText = "", outputHTML: String?
        let coordinator = RichComposerEditor.Coordinator { text, html in outputText = text; outputHTML = html }
        commands.changed = { coordinator.textViewDidChange(view) }
        commands.format(.bold)
        XCTAssertEqual(outputText, "A<B & C")
        XCTAssertTrue(outputHTML?.contains("<strong>A&lt;B</strong>") == true)
        XCTAssertTrue(outputHTML?.contains("&amp;") == true)
        commands.format(.underline)
        XCTAssertTrue(outputHTML?.contains("<u><strong>A&lt;B</strong></u>") == true)
        let attributes = view.textStorage.attributes(at: 4, effectiveRange: nil)
        XCTAssertFalse((attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
    }
    @MainActor func testDraftMarkupRestoresFormattingWithoutAnHTMLWebView() {
        let text = "A<B & C\n下一行😀"
        let rendered = ComposerAttributedText.restore(text: text, html: "<html><body><strong>A&lt;B</strong> &amp; <em><u>C</u></em><br>下一行😀</body></html>")
        XCTAssertEqual(rendered.string, text)
        XCTAssertTrue((rendered.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        XCTAssertTrue((rendered.attribute(.font, at: 6, effectiveRange: nil) as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitItalic) == true)
        XCTAssertEqual((rendered.attribute(.underlineStyle, at: 6, effectiveRange: nil) as? NSNumber)?.intValue, NSUnderlineStyle.single.rawValue)
        XCTAssertEqual(ComposerAttributedText.restore(text: text, html: "<html><body>different</body></html>").string, text)
        let external = "<!DOCTYPE html [<!ENTITY unsafe SYSTEM 'https://example.invalid/'>]><html><body>&unsafe;</body></html>"
        XCTAssertEqual(ComposerAttributedText.restore(text: text, html: external).string, text)
    }
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
        let moved = try await service.move(entry, summaries: [message], to: "Archive")
        XCTAssertEqual(moved?.first?.uid, 9); XCTAssertEqual(moved?.first?.folder, "Archive")
        XCTAssertEqual(moved?.first?.validity, 10)
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
        XCTAssertEqual(try configuration.url(requiringConsent: false).absoluteString, "https://example.test/v1/chat/completions")
        XCTAssertFalse(configuration.consent)
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
