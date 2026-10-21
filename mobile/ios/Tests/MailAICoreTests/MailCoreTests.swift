import XCTest
@testable import MailAICore

@MainActor private final class MemoryVault: CredentialStorage {
    var entries: [AccountCredential] = []
    var fail = false
    func load() throws -> [AccountCredential] { entries }
    func save(_ credentials: [AccountCredential]) throws {
        if fail { throw MailFailure.invalid("模拟钥匙串失败") }
        entries = credentials
    }
}

private actor MockMailService: MailService {
    enum Outcome { case accepted, rejected, unknown }
    var outcome: Outcome = .accepted
    var submissions = 0
    func setOutcome(_ value: Outcome) { outcome = value }
    func count() -> Int { submissions }
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { [] }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult {
        ReadResult(body: .init(text: "合成正文", html: nil), markedRead: true)
    }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws {
        submissions += 1
        switch outcome {
        case .accepted: return
        case .rejected: throw SubmissionFailure(uncertain: false)
        case .unknown: throw SubmissionFailure(uncertain: true)
        }
    }
}

@MainActor final class MailCoreTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }
    private func account(_ email: String = "demo@example.com") -> MailAccount {
        var a = MailAccount(); a.email = email; a.username = email
        a.imapHost = "imap.example.com"; a.smtpHost = "smtp.example.com"
        return a
    }
    private func setup() async throws -> (MailStore, MemoryVault, MockMailService, MailFiles) {
        let vault = MemoryVault(); let service = MockMailService(); let files = try MailFiles(root: directory)
        let store = MailStore(vault: vault, files: files, service: service)
        try await store.addAccount(account(), password: "synthetic-test-password")
        store.cancelRefresh()
        store.updateDraft { $0.to = "recipient@example.com"; $0.subject = "合成测试"; $0.text = "离线模拟邮件" }
        return (store, vault, service, files)
    }
    func testHeaderInjectionAndRecipientValidation() throws {
        XCTAssertThrowsError(try MailValidation.recipients("a@example.com\r\nBcc: b@example.com"))
        XCTAssertThrowsError(try MailValidation.recipients("wrong-address"))
        XCTAssertEqual(try MailValidation.recipients("a@example.com，A@example.com; b@example.com"), ["a@example.com", "b@example.com"])
        var draft = MailDraft(); draft.to = "a@example.com"; draft.text = "body"; draft.subject = "subject\nBcc: x@example.com"
        XCTAssertThrowsError(try draft.validateForSending())
    }
    func testServerValidationAndExactProviderMatching() throws {
        var a = account(); a.email = "a@qq.com.evil.example"; a.suggestServers()
        XCTAssertEqual(a.imapHost, "")
        a.email = "a@qq.com"; a.suggestServers(); XCTAssertEqual(a.imapHost, "imap.qq.com")
        for host in ["localhost", "127.0.0.1", "169.254.1.1", "::1", "https://imap.example.com", "a@example.com"] {
            a.imapHost = host; XCTAssertThrowsError(try a.validated(), host)
        }
        a.imapHost = "10.42.0.8"; XCTAssertThrowsError(try a.validated())
        a.imapHost = "imap.corp.example"; XCTAssertNoThrow(try a.validated())
    }
    func testNoSMTPSubmissionDuringAccountValidation() async throws {
        let (_, _, service, _) = try await setup()
        let count = await service.count(); XCTAssertEqual(count, 0)
    }
    func testUnknownAcceptanceLocksRetryAndSurvivesRestart() async throws {
        let (store, vault, service, files) = try await setup()
        await service.setOutcome(.unknown)
        do { try await store.send(); XCTFail("Expected uncertainty") } catch { XCTAssertEqual(error as? MailFailure, .uncertainSend) }
        XCTAssertEqual(store.draft.state, .uncertain)
        do { try await store.send(); XCTFail("Must not resubmit") } catch {}
        let count = await service.count(); XCTAssertEqual(count, 1)
        let recovered = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(recovered.draft.state, .uncertain)
        XCTAssertEqual(recovered.draft.text, "离线模拟邮件")
    }
    func testInterruptedSubmissionRecoversConservatively() async throws {
        let (store, vault, service, files) = try await setup()
        var interrupted = store.draft; interrupted.state = .submitting
        try files.write(interrupted, account: store.selectedID!, key: "draft")
        let recovered = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(recovered.draft.state, .uncertain)
        let count = await service.count(); XCTAssertEqual(count, 0)
    }
    func testExplicitRejectionPreservesEditableDraft() async throws {
        let (store, _, service, _) = try await setup(); await service.setOutcome(.rejected)
        do { try await store.send(); XCTFail("Expected rejection") } catch {}
        XCTAssertEqual(store.draft.state, .editing); XCTAssertEqual(store.draft.text, "离线模拟邮件")
    }
    func testAcceptedMailCannotBeSentAgain() async throws {
        let (store, _, service, _) = try await setup()
        try await store.send(); XCTAssertEqual(store.draft.state, .sent)
        do { try await store.send(); XCTFail("Must not resend accepted mail") } catch {}
        let count = await service.count(); XCTAssertEqual(count, 1)
    }
    func testKeychainFailureDoesNotAddAccount() async throws {
        let vault = MemoryVault(); vault.fail = true
        let store = MailStore(vault: vault, files: try MailFiles(root: directory), service: MockMailService())
        do { try await store.addAccount(account(), password: "synthetic"); XCTFail("Expected persistence failure") } catch {}
        XCTAssertTrue(store.accounts.isEmpty)
    }
    func testDraftsAndCachesAreIsolatedByAccountAndUIDValidity() async throws {
        let (store, _, _, files) = try await setup()
        let first = store.selectedID!
        try await store.addAccount(account("second@example.com"), password: "synthetic")
        store.cancelRefresh(); XCTAssertTrue(store.draft.isEmpty)
        store.updateDraft { $0.text = "第二账号草稿" }
        try store.selectAccount(first); XCTAssertEqual(store.draft.text, "离线模拟邮件")
        let a = MailSummary(uid: 1, validity: 10, folder: "INBOX", subject: "", sender: "", replyAddress: "", date: nil, unread: false)
        let b = MailSummary(uid: 1, validity: 11, folder: "INBOX", subject: "", sender: "", replyAddress: "", date: nil, unread: false)
        try files.write(MailBody(text: "旧正文", html: nil), account: first, key: "body:" + a.id)
        XCTAssertNil(try files.read(MailBody.self, account: first, key: "body:" + b.id))
    }
    func testCachedBodyRemainsAvailableOffline() async throws {
        let (store, _, _, files) = try await setup()
        let a = MailSummary(uid: 1, validity: 10, folder: "INBOX", subject: "", sender: "", replyAddress: "", date: nil, unread: false)
        try files.write(MailBody(text: "离线邮件", html: nil), account: store.selectedID!, key: "body:" + a.id)
        let body = try await store.body(for: a); XCTAssertEqual(body.text, "离线邮件")
    }
    func testStorageFailureKeepsUnsavedDraftInMemoryAndCanRetry() async throws {
        let (store, _, _, _) = try await setup()
        let directory = self.directory!
        try FileManager.default.removeItem(at: directory)
        try Data("synthetic storage fault".utf8).write(to: directory)
        store.updateDraft { $0.text = "保存失败时仍保留的新输入" }
        XCTAssertTrue(store.draftSaveFailed)
        XCTAssertEqual(store.draft.text, "保存失败时仍保留的新输入")
        try FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try store.saveDraft(); XCTAssertFalse(store.draftSaveFailed)
    }
}
