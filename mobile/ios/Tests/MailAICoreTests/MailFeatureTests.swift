import XCTest
@testable import MailAICore

@MainActor private final class FeatureVault: CredentialStorage {
    var entries: [AccountCredential] = []
    func load() throws -> [AccountCredential] { entries }
    func save(_ credentials: [AccountCredential]) throws { entries = credentials }
}
private actor FeatureService: MailService {
    var sent = 0; var archived = 0; var archiveFails = true
    var actions: [MailAction] = []
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Archive")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { [Self.item(folder: folder)] }
    static func item(folder: String = "INBOX") -> MailSummary { .init(uid: 7, validity: 10, folder: folder, subject: "合成主题", sender: "Sender", replyAddress: "sender@example.com", date: nil, unread: true) }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult { .init(body: .init(text: "synthetic", html: nil), markedRead: true) }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws { XCTAssertEqual(draft.attachments.first?.data, Data("synthetic".utf8)); sent += 1 }
    func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws { archived += 1; if archiveFails { throw MailFailure.invalid("synthetic archive fault") } }
    func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws { actions.append(action) }
    func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data { Data("synthetic".utf8) }
    func recordedActions() -> [MailAction] { actions }
    func move(_ credential: AccountCredential, summaries: [MailSummary], to folder: String) async throws -> [MailSummary]? {
        actions.append(.move(folder)); return summaries.map { $0.relocated(uid: $0.uid + 100, validity: 20, folder: folder) }
    }
    func allowArchive() { archiveFails = false }
    func counts() -> (Int, Int) { (sent, archived) }
}
@MainActor final class MailFeatureTests: XCTestCase {
    private var root: URL!
    override func setUp() async throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }
    private func setup() async throws -> (MailStore, FeatureVault, FeatureService, MailFiles) {
        let vault = FeatureVault(), service = FeatureService(), files = try MailFiles(root: root)
        let store = MailStore(vault: vault, files: files, service: service)
        var account = MailAccount(); account.email = "demo@example.com"; account.suggestServers()
        try await store.addAccount(account, password: "synthetic-password"); store.cancelRefresh()
        return (store, vault, service, files)
    }
    func testLegacyDraftAndAccountDecodeWithoutLosingContent() throws {
        let data = Data(#"{"to":"a@example.com","subject":"旧草稿","text":"正文","state":"editing"}"#.utf8)
        let draft = try JSONDecoder().decode(MailDraft.self, from: data)
        XCTAssertEqual(draft.text, "正文"); XCTAssertTrue(draft.cc.isEmpty); XCTAssertTrue(draft.attachments.isEmpty)
        XCTAssertNil(draft.identifier)
    }
    func testMultipleDraftsSurviveRestartAndOpeningDoesNotOverwriteAnother() async throws {
        let (store, vault, service, files) = try await setup()
        store.updateDraft { $0.text = "第一封" }; let first = store.draft.id
        try store.newDraft(); store.updateDraft { $0.text = "第二封" }; let second = store.draft.id
        XCTAssertNotEqual(first, second)
        try store.openDraft(first); XCTAssertEqual(store.draft.text, "第一封")
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(restored.drafts.count, 2)
        try restored.openDraft(second); XCTAssertEqual(restored.draft.text, "第二封")
    }
    func testDeletingOneDraftPreservesOtherDrafts() async throws {
        let (store, _, _, _) = try await setup()
        store.updateDraft { $0.text = "保留" }; let first = store.draft.id
        try store.newDraft(); store.updateDraft { $0.text = "删除" }; let second = store.draft.id
        try store.discardDraft(second)
        XCTAssertEqual(store.drafts.map(\.id), [first]); try store.openDraft(first); XCTAssertEqual(store.draft.text, "保留")
    }
    func testRecipientsAreDeduplicatedAcrossToCcBccAndLimitedTogether() throws {
        var draft = MailDraft(); draft.to = "a@example.com"; draft.cc = "A@example.com,b@example.com"; draft.bcc = "B@example.com,c@example.com"; draft.text = "body"
        let groups = try draft.recipientGroups()
        XCTAssertEqual(groups.to, ["a@example.com"]); XCTAssertEqual(groups.cc, ["b@example.com"]); XCTAssertEqual(groups.bcc, ["c@example.com"])
        draft.bcc = "x@example.com\r\nBcc:evil@example.com"; XCTAssertThrowsError(try draft.validateForSending())
    }
    func testAttachmentsUseSeparateFilesAndAreHydratedOnlyForSending() async throws {
        let (store, vault, service, files) = try await setup()
        store.updateDraft { $0.to = "a@example.com"; $0.text = "synthetic" }
        try store.addAttachment(name: "../../合同.txt", mimeType: "text/plain", data: Data("synthetic".utf8))
        XCTAssertEqual(store.draft.attachments.first?.name, "合同.txt"); XCTAssertNil(store.draft.attachments.first?.data)
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertNil(restored.draft.attachments.first?.data)
        try await restored.send(); XCTAssertEqual(restored.draft.state, .sent)
        XCTAssertNil(restored.draft.attachments.first?.data)
        let counts = await service.counts(); XCTAssertEqual(counts.0, 1)
    }
    func testSentCopyRetryNeverSubmitsSMTPAgain() async throws {
        let (store, _, service, _) = try await setup()
        store.updateDraft { $0.to = "a@example.com"; $0.text = "synthetic" }
        try store.addAttachment(name: "test.txt", mimeType: "text/plain", data: Data("synthetic".utf8))
        try await store.send(); XCTAssertEqual(store.draft.state, .sent); XCTAssertEqual(store.draft.sentCopyPending, true)
        await service.allowArchive(); try await store.retrySentCopy()
        let counts = await service.counts(); XCTAssertEqual(counts.0, 1); XCTAssertEqual(counts.1, 2)
        XCTAssertEqual(store.draft.sentCopyPending, false)
    }
    func testAttachmentSizeLimitRejectsBeforeChangingDraft() async throws {
        let (store, _, _, _) = try await setup()
        XCTAssertThrowsError(try store.addAttachment(name: "large.bin", mimeType: "application/octet-stream", data: Data(count: MailAttachment.singleLimit + 1)))
        XCTAssertTrue(store.draft.attachments.isEmpty)
    }
    func testReplyAllExcludesOwnAddressAndKeepsOriginalDraft() async throws {
        let (store, _, _, _) = try await setup()
        store.updateDraft { $0.text = "已有草稿" }; let old = store.draft.id
        var summary = FeatureService.item(); summary.messageID = "<synthetic@example.com>"
        let body = MailBody(text: "原文", html: nil, recipients: [.init(email: "demo@example.com"), .init(email: "team@example.com")], carbonCopies: [.init(email: "TEAM@example.com"), .init(email: "sender@example.com")])
        try store.compose(mode: .replyAll, summary: summary, body: body)
        XCTAssertEqual(store.draft.to, "sender@example.com"); XCTAssertEqual(store.draft.cc, "team@example.com")
        XCTAssertTrue(store.draft.text.contains("原文")); XCTAssertTrue(store.drafts.contains { $0.id == old && $0.text == "已有草稿" })
    }
    func testContactsAreScopedToAccountAndManualNotesPersist() async throws {
        let (store, vault, service, files) = try await setup()
        try store.saveContact(.init(email: "a@example.com", name: "A", note: "业务联系人"))
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(restored.contacts.first?.note, "业务联系人")
        var second = MailAccount(); second.email = "other@example.com"; second.suggestServers()
        try await restored.addAccount(second, password: "synthetic"); restored.cancelRefresh(); XCTAssertTrue(restored.contacts.isEmpty)
    }
    func testThreadsUseReplyIdentityInsteadOfMergingEqualSubjects() {
        var first = FeatureService.item(); first.messageID = "<a@example.com>"
        var reply = MailSummary(uid: 8, validity: 10, folder: "INBOX", subject: "Re: 合成主题", sender: "A", replyAddress: "a@example.com", date: nil, unread: true, messageID: "<b@example.com>")
        reply.parentMessageID = "<a@example.com>"
        let unrelated = MailSummary(uid: 9, validity: 10, folder: "INBOX", subject: first.subject, sender: "B", replyAddress: "b@example.com", date: nil, unread: false, messageID: "<other@example.com>")
        let threads = MailThread.group([reply, first, unrelated])
        XCTAssertEqual(threads.count, 2); XCTAssertEqual(threads.map { $0.messages.count }.sorted(), [1, 2])
    }
    func testUndoRestoresThePreviousReadFlag() async throws {
        let (store, _, service, _) = try await setup()
        try await store.perform(.read(true), on: [FeatureService.item()])
        XCTAssertNotNil(store.undoID)
        try await store.undoLastAction(); store.cancelRefresh()
        let actions = await service.recordedActions()
        XCTAssertEqual(actions, [.read(true), .read(false)])
        XCTAssertNil(store.undoID)
    }
    func testMoveUndoUsesDestinationUIDsRatherThanStaleSourceUIDs() async throws {
        let (store, _, service, _) = try await setup()
        try await store.perform(.move("Archive"), on: [FeatureService.item()])
        XCTAssertNotNil(store.undoID)
        try await store.undoLastAction(); store.cancelRefresh()
        let actions = await service.recordedActions()
        XCTAssertEqual(actions, [.move("Archive"), .move("INBOX")])
    }
    func testAttachmentNamesCannotEscapePreviewDirectory() {
        XCTAssertEqual(MailAttachment.safeName("..\\..\\file.txt"), "file.txt")
        XCTAssertFalse(MailAttachment.safeName("x\r\ny.txt").contains("\n"))
    }
}
