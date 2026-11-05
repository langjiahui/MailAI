import XCTest
import MailAICore
import Security
import UIKit
import SwiftMail
import ImageIO
import CryptoKit
@testable import MailAI

final class ProtocolTests: XCTestCase {
    @MainActor func testBackgroundCredentialsUseSeparateAfterFirstUnlockRecordAndCanBeRemoved() throws {
        let foregroundService = "com.mailai.tests.foreground." + UUID().uuidString
        let backgroundService = "com.mailai.tests.background." + UUID().uuidString
        let foreground = KeychainVault(service: foregroundService)
        let background = KeychainVault(service: backgroundService, backgroundAccess: true)
        defer { try? foreground.remove(); try? background.remove() }
        let entry = credential(); try foreground.save([entry])
        // Existing records must migrate their attributes when enabling background access.
        try KeychainVault(service: backgroundService).save([entry]); try background.save([entry])
        func accessibility(_ service: String) throws -> String {
            var value: CFTypeRef?
            let result = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "accounts", kSecReturnAttributes: true] as CFDictionary, &value)
            XCTAssertEqual(result, errSecSuccess)
            return try XCTUnwrap((value as? [String: Any])?[kSecAttrAccessible as String] as? String)
        }
        XCTAssertEqual(try accessibility(foregroundService), kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(try accessibility(backgroundService), kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        try background.remove(); XCTAssertTrue(try background.load().isEmpty)
        XCTAssertEqual(try foreground.load().first?.password, "synthetic-password")
    }
    @MainActor func testNotificationStateHasBackgroundProtectionWhileBodiesAndAttachmentsStayLocked() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let account = UUID(), privateRoot = root.appendingPathComponent("private")
        let files = try MailFiles(root: privateRoot)
        try files.write(["synthetic private body"], account: account, key: "body")
        try files.writeData(Data("synthetic attachment".utf8), account: account, key: "attachment")
        let notice = try MailNotificationFile(root: root.appendingPathComponent("notifications")); try notice.save(MailNotificationLedger())
        #if targetEnvironment(simulator)
        // Simulator reports the Mac volume's capabilities but does not return
        // iPhone protection attributes. Verify IO here; the same test asserts
        // actual protection classes on the physical iPhone before installation.
        XCTAssertEqual(try files.read([String].self, account: account, key: "body"), ["synthetic private body"])
        XCTAssertEqual(try files.readData(account: account, key: "attachment"), Data("synthetic attachment".utf8))
        XCTAssertTrue(try notice.load().pending.isEmpty)
        #else
        for file in try FileManager.default.contentsOfDirectory(at: privateRoot.appendingPathComponent(account.uuidString), includingPropertiesForKeys: nil) {
            let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
            XCTAssertEqual(attrs[.protectionKey] as? String, FileProtectionType.complete.rawValue)
        }
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: notice.url.path)[.protectionKey] as? String, FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: notice.url.deletingLastPathComponent().path)[.protectionKey] as? String, FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
        #endif
    }
    func testCorrespondencePaginationAdvancesEvenWhenHeaderSearchOnlyHasFalsePositives() async throws {
        let service = NativeMailService(), entry = credential()
        let first = try await service.correspondencePage(entry, folder: "INBOX", address: "paging@example.com", beforeUID: nil, limit: 1)
        XCTAssertTrue(first.messages.isEmpty); XCTAssertEqual(first.total, 2); XCTAssertEqual(first.nextUID, 8)
        let second = try await service.correspondencePage(entry, folder: "INBOX", address: "paging@example.com", beforeUID: first.nextUID, limit: 1)
        XCTAssertTrue(second.messages.isEmpty); XCTAssertEqual(second.total, 2); XCTAssertNil(second.nextUID)
        let exhausted = try await service.correspondencePage(entry, folder: "INBOX", address: "paging@example.com", beforeUID: 7, limit: 1)
        XCTAssertTrue(exhausted.messages.isEmpty); XCTAssertEqual(exhausted.total, 2); XCTAssertNil(exhausted.nextUID)
    }
    func testMalformedMetadataRecoversWithFreshReadOnlyHeaderFetch() async throws {
        let service = NativeMailService()
        for port in [1995, 1996] {
            var entry = credential(); entry.account.imapPort = port
            let list = try await service.summaries(entry, folder: "INBOX", limit: 50)
            XCTAssertEqual(list.count, 1)
            XCTAssertEqual(list.first?.uid, 7); XCTAssertEqual(list.first?.validity, 10)
            XCTAssertEqual(list.first?.subject, "Synthetic mail")
            XCTAssertEqual(list.first?.senderName, "测试发件人")
            XCTAssertEqual(list.first?.senderAddress, "sender@example.com")
            // The next refresh must reuse the successful per-account mode.
            let again = try await service.summaries(entry, folder: "INBOX", limit: 50)
            XCTAssertEqual(again.map(\.uid), [7])
        }
    }
    func testConnectionDiagnosticsExcludeServerResponsesAndCredentials() throws {
        let secret = "synthetic-sensitive@example.invalid synthetic-password"
        let (issue, record) = NativeMailService.diagnostic(IMAPError.loginFailed(secret), phase: .imapLogin)
        XCTAssertEqual(issue, .authentication)
        let text = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
        XCTAssertFalse(text.contains(secret)); XCTAssertFalse(text.contains("synthetic-sensitive"))
        XCTAssertEqual(record["phase"], "imapLogin")
        let (parse, _) = NativeMailService.diagnostic(IMAPParseError.malformedResponse(secret), phase: .imapRequest)
        XCTAssertEqual(parse, .malformedResponse)
    }
    func testModelKeyOnlySetupPreservesLegacyConfigAndClearsKeysOnProviderChange() throws {
        var value = AssistantConfiguration(); value.key = " synthetic-key\n"
        XCTAssertEqual(value.normalized().key, "synthetic-key")
        XCTAssertEqual(try value.normalized().url(requiringConsent: false).absoluteString, "https://api.deepseek.com/v1/chat/completions")
        value.consent = true; value.selectProvider(.kimi)
        XCTAssertTrue(value.key.isEmpty); XCTAssertFalse(value.consent)
        XCTAssertEqual(value.endpoint, "https://api.moonshot.cn/v1"); XCTAssertEqual(value.model, "kimi-k2.6")
        let legacy = Data(#"{"endpoint":"https://gateway.example.com/v1","model":"my-model","key":"synthetic","consent":true}"#.utf8)
        let restored = try JSONDecoder().decode(AssistantConfiguration.self, from: legacy)
        XCTAssertEqual(restored.provider, .custom); XCTAssertEqual(restored.model, "my-model")
        XCTAssertEqual(restored.key, "synthetic"); XCTAssertTrue(restored.consent)
        XCTAssertEqual(try restored.url().host, "gateway.example.com")
    }
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
        XCTAssertEqual(messages.first?.senderName, "测试发件人")
        XCTAssertEqual(messages.first?.senderAddress, "sender@example.com")
        XCTAssertEqual(messages.first?.recipients?.first?.name, "李四")
        XCTAssertEqual(messages.first?.carbonCopies?.first?.name, "王五")
        let result = try await service.read(entry, summary: XCTUnwrap(messages.first))
        XCTAssertTrue(result.body.text.contains("Synthetic offline message")); XCTAssertTrue(result.markedRead)
    }
    func testIPLiteralUsesTLSIdentityVerificationForBothMailProtocols() async throws {
        let service = NativeMailService()
        var entry = credential()
        // Loopback is synthetic only; account validation still rejects it. The
        // trusted fixture contains an exact IP SAN as corporate IP certs must.
        entry.account.imapHost = "127.0.0.1"; entry.account.smtpHost = "127.0.0.1"
        try await service.validate(entry)
        for smtp in [false, true] {
            var wrong = entry
            if smtp { wrong.account.smtpPort = 1466 } else { wrong.account.imapPort = 1994 }
            do {
                try await service.validate(wrong)
                XCTFail("A trusted CA must not make a mismatched IP SAN valid")
            } catch {
                let issue = try XCTUnwrap(error as? MailConnectionFailure)
                XCTAssertTrue([MailConnectionFailure.certificate, .tlsNegotiation].contains(issue), "Must reach the TLS check, not fail on routing: \(error)")
            }
        }
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
    private func syntheticPhoto(side: Int) throws -> Data {
        var pixels = [UInt8](repeating: 255, count: side * side * 4)
        var seed: UInt32 = 0x12345678
        for index in pixels.indices where index % 4 != 3 {
            seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
            pixels[index] = UInt8(truncatingIfNeeded: seed)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try XCTUnwrap(CGImage(width: side, height: side, bitsPerComponent: 8,
            bitsPerPixel: 32, bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }
    func testImportedPhotoUsesActualImageBytesAndPreservesRepresentation() throws {
        let png = try syntheticPhoto(side: 32)
        let imported = try ImportedMailPhoto.attachment(png)
        XCTAssertEqual(imported.name, "照片.png"); XCTAssertEqual(imported.mimeType, "image/png")
        XCTAssertEqual(imported.data, png)
        let image = try XCTUnwrap(UIImage(data: png))
        let jpeg = try XCTUnwrap(image.jpegData(compressionQuality: 0.9))
        let importedJPEG = try ImportedMailPhoto.attachment(jpeg)
        XCTAssertTrue(["照片.jpg", "照片.jpeg"].contains(importedJPEG.name))
        XCTAssertEqual(importedJPEG.mimeType, "image/jpeg"); XCTAssertEqual(importedJPEG.data, jpeg)
    }
    func testImportedPhotoRejectsEmptyAndTruncatedPNG() throws {
        XCTAssertThrowsError(try ImportedMailPhoto.attachment(Data()))
        let png = try syntheticPhoto(side: 32)
        XCTAssertThrowsError(try ImportedMailPhoto.attachment(Data(png.dropLast(12))))
        XCTAssertThrowsError(try ImportedMailPhoto.attachment(Data(png.prefix(png.count / 2))))
    }
    func testLargePhotoSMTPMatchesOriginalByteHashAtReceiver() async throws {
        // Larger than the reported 9.7 MB source; synthetic pixels only.
        let png = try syntheticPhoto(side: 1800)
        XCTAssertGreaterThan(png.count, 9_746_089)
        XCTAssertLessThan(png.count, MailAttachment.singleLimit)
        let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        var draft = MailDraft(); draft.to = "photo-integrity@example.com"
        draft.subject = "synthetic photo integrity"
        draft.text = "synthetic photo sha256:\(digest) bytes:\(png.count)"
        draft.attachments = [try ImportedMailPhoto.attachment(png)]
        // The real production builder and TLS SMTP submission path are used.
        // The fixture returns 250 only after decoding MIME and verifying the hash.
        try await NativeMailService().send(credential(), draft: draft)
    }
    func testCorrespondenceUsesParticipantHeadersAndMetadataFallback() async throws {
        let service = NativeMailService()
        for port in [1993, 1995, 1996] {
            var entry = credential(); entry.account.imapPort = port
            let result = try await service.correspondence(entry, folder: "INBOX", address: "sender@example.com", limit: 50)
            XCTAssertEqual(result.messages.map(\.uid), [7]); XCTAssertEqual(result.messages.first?.senderName, "测试发件人")
            let wrong = try await service.correspondence(entry, folder: "INBOX", address: "not-sender@example.com", limit: 50)
            XCTAssertTrue(wrong.messages.isEmpty)
        }
    }
    func testBatchMoveRetainsEveryUIDAndDestinationMapping() async throws {
        let service = NativeMailService(); let entry = credential()
        let list = try await service.summaries(entry, folder: "INBOX", limit: 50)
        let first = try XCTUnwrap(list.first)
        let second = first.relocated(uid: 8, validity: first.validity, folder: first.folder)
        let receipt = try await service.move(entry, summaries: [first, second], to: "Trash")
        let moved = try XCTUnwrap(receipt)
        XCTAssertEqual(Set(moved.map(\.uid)), [9,10]); XCTAssertTrue(moved.allSatisfy { $0.folder == "Trash" && $0.validity == 10 })
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
