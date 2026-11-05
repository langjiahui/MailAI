import XCTest
@testable import MailAICore

private actor NotificationService: MailService {
    var snapshots: [UUID: [MailSummary]] = [:]
    var failures = Set<UUID>()
    func set(_ items: [MailSummary], account: UUID) { snapshots[account] = items }
    func fail(_ account: UUID) { failures.insert(account) }
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] {
        if failures.contains(credential.account.id) { throw MailFailure.invalid("synthetic connection failure") }
        return snapshots[credential.account.id] ?? []
    }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult { .init(body: .init(text: "synthetic", html: nil), markedRead: false) }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws {}
}
@MainActor private final class NotificationVault: CredentialStorage {
    var entries: [AccountCredential]
    var locked = false
    init(_ entries: [AccountCredential]) { self.entries = entries }
    func load() throws -> [AccountCredential] { if locked { throw MailFailure.missingPassword }; return entries }
    func save(_ credentials: [AccountCredential]) throws { entries = credentials }
}
@MainActor final class MailNotificationTests: XCTestCase {
    private let account = UUID()
    private var root: URL!
    override func setUp() async throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }
    private func item(_ uid: UInt32, validity: UInt32 = 10, unread: Bool = true) -> MailSummary {
        .init(uid: uid, validity: validity, folder: "INBOX", subject: "合成主题", sender: "synthetic@example.com", replyAddress: "synthetic@example.com", date: nil, unread: unread)
    }
    private func entry(_ id: UUID) -> AccountCredential {
        var account = MailAccount(id: id); account.email = "synthetic@example.com"; account.suggestServers()
        return .init(account: account, password: "synthetic-notification-only")
    }
    func testLockedStartupDoesNotMasqueradeAsFirstRunOrEraseAccounts() throws {
        let vault = NotificationVault([entry(account)]), service = NotificationService(), files = try MailFiles(root: root)
        vault.locked = true
        let locked = MailStore(vault: vault, files: files, service: service)
        XCTAssertFalse(locked.startupReady); XCTAssertNotNil(locked.error); XCTAssertEqual(vault.entries.count, 1)
        vault.locked = false
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertTrue(restored.startupReady); XCTAssertEqual(restored.accounts.map(\.id), [account]); XCTAssertEqual(vault.entries.count, 1)
    }
    func testFirstSnapshotDoesNotNotifyHistoricalMail() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [item(7), item(8)], permitted: true, preview: false)
        XCTAssertTrue(state.pending.isEmpty); XCTAssertEqual(state.cursors[account]?.uid, 8)
    }
    func testFirstMailAfterEmptyInboxDoesNotify() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(1)], permitted: true, preview: false)
        XCTAssertEqual(state.pending.map { $0.target.uid }, [1])
    }
    func testUnreadDeduplicationAndStaleResponsesNeverRegressCursor() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [item(7)], permitted: true, preview: false)
        for _ in 0..<2 { try state.observe(account: account, messages: [item(7), item(8), item(9, unread: false)], permitted: true, preview: false) }
        XCTAssertEqual(state.pending.map { $0.target.uid }, [8])
        try state.observe(account: account, messages: [item(7)], permitted: true, preview: false)
        XCTAssertEqual(state.cursors[account]?.uid, 9)
        state.acknowledge(state.pending)
        try state.observe(account: account, messages: [item(8), item(9, unread: false)], permitted: true, preview: false)
        XCTAssertTrue(state.pending.isEmpty)
    }
    func testUIDValidityChangeRebasesAndDropsOldPending() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(8)], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(1, validity: 99)], permitted: true, preview: false)
        XCTAssertTrue(state.pending.isEmpty); XCTAssertEqual(state.cursors[account]?.validity, 99)
    }
    func testDeniedPermissionDoesNotReplayOldMailWhenAllowedLater() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(1)], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(2)], permitted: false, preview: false)
        try state.observe(account: account, messages: [item(2), item(3)], permitted: true, preview: false)
        XCTAssertEqual(state.pending.map { $0.target.uid }, [3])
    }
    func testGenericPrivacyAndOptOutScrubsQueuedPreviews() throws {
        var state = MailNotificationLedger()
        try state.observe(account: account, messages: [], permitted: true, preview: true)
        try state.observe(account: account, messages: [item(1)], permitted: true, preview: true)
        XCTAssertEqual(state.pending.first?.subject, "合成主题")
        state.hidePreviews()
        let text = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        XCTAssertFalse(text.contains("合成主题")); XCTAssertFalse(text.contains("synthetic@example.com"))
        XCTAssertNil(state.pending.first?.sender)
    }
    func testRemovingAccountDropsOnlyItsCursorAndPending() throws {
        let other = UUID(); var state = MailNotificationLedger()
        for id in [account, other] { try state.observe(account: id, messages: [], permitted: true, preview: false); try state.observe(account: id, messages: [item(1)], permitted: true, preview: false) }
        state.retainAccounts([other]); XCTAssertNil(state.cursors[account]); XCTAssertEqual(state.pending.map { $0.target.accountID }, [other])
    }
    func testMixedMailboxMetadataFailsWithoutChangingState() throws {
        var state = MailNotificationLedger()
        XCTAssertThrowsError(try state.observe(account: account, messages: [item(1), item(2, validity: 99)], permitted: true, preview: false))
        XCTAssertTrue(state.cursors.isEmpty); XCTAssertTrue(state.pending.isEmpty)
    }
    func testNotificationFileRoundTripStoresNoCredentialsOrBody() throws {
        let file = try MailNotificationFile(root: root); var state = MailNotificationLedger()
        try state.observe(account: account, messages: [], permitted: true, preview: false)
        try state.observe(account: account, messages: [item(1)], permitted: true, preview: false)
        try file.save(state); XCTAssertEqual(try file.load().pending, state.pending)
        let text = try String(contentsOf: file.url, encoding: .utf8)
        for value in ["password", "合成主题", "synthetic@example.com", "attachments", "draft"] { XCTAssertFalse(text.contains(value)) }
        try file.remove(); XCTAssertTrue(try file.load().pending.isEmpty)
    }
    func testFailedDeliverySurvivesRestartAndRetriesSameIdentifier() async throws {
        let service = NotificationService(), file = try MailNotificationFile(root: root), credentials = [entry(account)]
        await service.set([item(7)], account: account)
        _ = try await MailNotificationCheck.run(credentials: credentials, service: service, file: file, permitted: true, preview: false) { _ in XCTFail("Baseline must not alert") }
        await service.set([item(8)], account: account)
        var identifier = ""
        let failed = try await MailNotificationCheck.run(credentials: credentials, service: service, file: file, permitted: true, preview: false) { batch in identifier = batch[0].target.identifier; throw MailFailure.invalid("synthetic OS rejection") }
        XCTAssertEqual(failed.deliveryFailures, 1); XCTAssertEqual(try file.load().pending.count, 1)
        let retried = try await MailNotificationCheck.run(credentials: credentials, service: service, file: MailNotificationFile(root: root), permitted: true, preview: false) { batch in XCTAssertEqual(batch.count, 1); XCTAssertEqual(batch[0].target.identifier, identifier) }
        XCTAssertEqual(retried.submittedMessages, 1); XCTAssertTrue(try file.load().pending.isEmpty)
        _ = try await MailNotificationCheck.run(credentials: credentials, service: service, file: file, permitted: true, preview: false) { _ in XCTFail("No duplicate alert after ack") }
    }
    func testOneAccountFailureDoesNotBlockOthers() async throws {
        let other = UUID(), service = NotificationService(), file = try MailNotificationFile(root: root)
        var state = MailNotificationLedger(); for id in [account, other] { try state.observe(account: id, messages: [], permitted: true, preview: false) }; try file.save(state)
        await service.set([item(1)], account: account); await service.fail(other)
        let result = try await MailNotificationCheck.run(credentials: [entry(account), entry(other)], service: service, file: file, permitted: true, preview: false) { batch in XCTAssertEqual(batch[0].target.accountID, self.account) }
        XCTAssertEqual(result.checkedAccounts, 1); XCTAssertEqual(result.failedAccounts, 1); XCTAssertEqual(result.submittedMessages, 1)
    }
    func testCancellationDoesNotAcknowledgePendingDelivery() async throws {
        let service = NotificationService(), file = try MailNotificationFile(root: root)
        var state = MailNotificationLedger(); try state.observe(account: account, messages: [], permitted: true, preview: false); try file.save(state)
        await service.set([item(1)], account: account)
        let job = Task { try await MailNotificationCheck.run(credentials: [entry(account)], service: service, file: file, permitted: true, preview: false) { _ in try await Task.sleep(for: .seconds(5)) } }
        for _ in 0..<100 { if !(try file.load().pending.isEmpty) { break }; try await Task.sleep(for: .milliseconds(5)) }
        job.cancel()
        do { _ = try await job.value; XCTFail("Cancellation must not report success") } catch is CancellationError {} catch { XCTFail("Unexpected error") }
        XCTAssertEqual(try file.load().pending.count, 1)
    }
    func testNotificationRouteValidatesAccountAndUIDValidityAndPreservesDraft() async throws {
        let service = NotificationService(), vault = NotificationVault([entry(account)]), files = try MailFiles(root: root)
        let store = MailStore(vault: vault, files: files, service: service)
        store.updateDraft { $0.text = "合成未完成草稿" }
        await service.set([item(7)], account: account)
        let missing = try await store.messageForNotification(.init(accountID: account, uid: 7, validity: 99))
        XCTAssertNil(missing); XCTAssertEqual(store.draft.text, "合成未完成草稿")
        let valid = try await store.messageForNotification(.init(accountID: account, uid: 7, validity: 10))
        XCTAssertEqual(valid?.uid, 7); XCTAssertEqual(store.draft.text, "合成未完成草稿")
        do { _ = try await store.messageForNotification(.init(accountID: UUID(), uid: 7, validity: 10)); XCTFail("Removed account must not open") } catch {}
        store.cancelRefresh()
    }
}
