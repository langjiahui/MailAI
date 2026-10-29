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
    var actedUIDs: [UInt32] = []
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Archive")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { [Self.item(folder: folder)] }
    static func item(folder: String = "INBOX") -> MailSummary { .init(uid: 7, validity: 10, folder: folder, subject: "合成主题", sender: "Sender", replyAddress: "sender@example.com", date: nil, unread: true) }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult { .init(body: .init(text: "synthetic", html: nil), markedRead: true) }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws { XCTAssertEqual(draft.attachments.first?.data, Data("synthetic".utf8)); sent += 1 }
    func archiveSent(_ credential: AccountCredential, draft: MailDraft) async throws { archived += 1; if archiveFails { throw MailFailure.invalid("synthetic archive fault") } }
    func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws { actions.append(action); actedUIDs += summaries.map(\.uid) }
    func attachment(_ credential: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data { Data("synthetic".utf8) }
    func recordedActions() -> [MailAction] { actions }
    func recordedUIDs() -> [UInt32] { actedUIDs }
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
        let undoUIDs = await service.recordedUIDs(); XCTAssertEqual(undoUIDs, [107])
    }
    func testLegacyBodyRemainsReadableAndCanAcquireAttachmentMetadata() async throws {
        struct LegacyBody: Encodable { let text: String; let html: String? }
        let (store, _, _, files) = try await setup()
        let summary = FeatureService.item()
        try files.write(LegacyBody(text: "旧正文", html: nil), account: store.selectedID!, key: "body:" + summary.id)
        let cached = try await store.body(for: summary)
        XCTAssertEqual(cached.text, "旧正文"); XCTAssertNil(cached.attachments)
        let upgraded = try await store.body(for: summary, refreshMetadata: true)
        XCTAssertEqual(upgraded.text, "synthetic"); XCTAssertEqual(upgraded.attachments, [])
        let reread = try await store.body(for: summary); XCTAssertEqual(reread.attachments, [])
    }
    func testEditingContactEmailReplacesOnlyThatContact() async throws {
        let (store, _, _, _) = try await setup()
        try store.saveContact(.init(email: "first@example.com", note: "保留备注"))
        try store.saveContact(.init(email: "other@example.com", note: "其他联系人"))
        try store.saveContact(.init(email: "changed@example.com", note: "保留备注"), replacingEmail: "first@example.com")
        XCTAssertFalse(store.contacts.contains { $0.email == "first@example.com" })
        XCTAssertEqual(Set(store.contacts.map(\.email)), Set(["changed@example.com", "other@example.com"]))
    }
    func testRemovingAnotherAccountPreservesActiveDraftAndContacts() async throws {
        let (store, vault, service, files) = try await setup()
        let first = try XCTUnwrap(store.selectedID)
        var second = MailAccount(); second.email = "second@example.com"; second.suggestServers()
        try await store.addAccount(second, password: "synthetic"); store.cancelRefresh()
        try store.selectAccount(first)
        store.updateDraft { $0.to = "keep@example.com"; $0.text = "保留的草稿" }
        let draftID = store.draft.id
        try store.saveContact(.init(email: "keep@example.com", note: "保留联系人"))
        try store.removeAccount(second.id)
        XCTAssertEqual(store.selectedID, first); XCTAssertEqual(store.draft.id, draftID)
        XCTAssertEqual(store.draft.text, "保留的草稿"); XCTAssertEqual(store.contacts.first?.note, "保留联系人")
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(restored.accounts.map(\.id), [first]); XCTAssertEqual(restored.draft.text, "保留的草稿")
    }
    func testForwardStartsWithNoInheritedRecipients() async throws {
        let (store, _, _, _) = try await setup()
        store.updateDraft { $0.to = "old@example.com"; $0.cc = "cc@example.com"; $0.bcc = "bcc@example.com"; $0.text = "旧草稿" }
        let original = store.draft.id
        try store.compose(mode: .forward, summary: FeatureService.item(), body: MailBody(text: "需要转发的原文", html: nil, recipients: [.init(email: "old@example.com")]))
        XCTAssertTrue(store.draft.to.isEmpty); XCTAssertTrue(store.draft.cc.isEmpty); XCTAssertTrue(store.draft.bcc.isEmpty)
        XCTAssertTrue(store.draft.text.contains("需要转发的原文")); XCTAssertThrowsError(try store.draft.validateForSending())
        XCTAssertTrue(store.drafts.contains { $0.id == original && $0.bcc == "bcc@example.com" })
    }
    func testAttachmentNamesCannotEscapePreviewDirectory() {
        XCTAssertEqual(MailAttachment.safeName("..\\..\\file.txt"), "file.txt")
        XCTAssertFalse(MailAttachment.safeName("x\r\ny.txt").contains("\n"))
    }
    func testCachedMailBackfillsChineseNamesAndPreservesManualEdits() async throws {
        let (store, vault, service, files) = try await setup()
        let account = try XCTUnwrap(store.selectedID)
        var message = FeatureService.item()
        message.sender = "\"张三\" <sender@example.com>"; message.senderName = "张三"
        message.recipients = [.init(name: "李四", email: "li@example.com"), .init(name: "自己", email: "demo@example.com")]
        message.carbonCopies = [.init(name: "王五", email: "wang@example.com")]
        try files.write([message], account: account, key: "list:INBOX")
        try files.write([MailContact(email: "sender@example.com"), .init(email: "li@example.com", name: "手动姓名", note: "保留备注", manuallyEdited: true)], account: account, key: "contacts")
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(restored.contacts.first { $0.email == "sender@example.com" }?.name, "张三")
        XCTAssertEqual(restored.contacts.first { $0.email == "li@example.com" }?.name, "手动姓名")
        XCTAssertEqual(restored.contacts.first { $0.email == "li@example.com" }?.note, "保留备注")
        XCTAssertEqual(restored.contacts.first { $0.email == "wang@example.com" }?.name, "王五")
        XCTAssertFalse(restored.contacts.contains { $0.email == "demo@example.com" })
        let reread = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(reread.contacts, restored.contacts)
    }
    func testSenderNameDoesNotGetAssignedToDifferentReplyToAddress() {
        var message = FeatureService.item()
        message.sender = "\"张三\" <actual@example.com>"; message.senderName = "张三"; message.replyAddress = "reply@example.com"
        XCTAssertEqual(message.contactAddresses, [.init(name: "张三", email: "actual@example.com"), .init(email: "reply@example.com")])
        message.senderAddress = "actual@example.com"
        XCTAssertEqual(message.relocated(uid: 9, validity: 11, folder: "Archive").senderAddress, "actual@example.com")
    }
    func testNamesLearnedByFolderAndUnifiedRefreshStayWithTheirAccount() async throws {
        let (store, _, _, files) = try await setup()
        let first = try XCTUnwrap(store.selectedID)
        var cached = FeatureService.item(folder: "Archive"); cached.senderName = "缓存姓名"
        try files.write([cached], account: first, key: "list:Archive")
        try store.selectFolder("Archive"); store.cancelRefresh()
        XCTAssertEqual(store.contacts.first { $0.email == "sender@example.com" }?.name, "缓存姓名")
        var second = MailAccount(); second.email = "other@example.com"; second.suggestServers()
        try await store.addAccount(second, password: "synthetic"); store.cancelRefresh()
        try await store.refreshAllInboxes()
        let a = try files.read([MailContact].self, account: first, key: "contacts")
        let b = try files.read([MailContact].self, account: second.id, key: "contacts")
        XCTAssertEqual(a?.first { $0.email == "sender@example.com" }?.name, "缓存姓名")
        XCTAssertEqual(b?.first { $0.email == "sender@example.com" }?.name, "Sender")
        XCTAssertEqual(store.contacts, b)
    }
}
