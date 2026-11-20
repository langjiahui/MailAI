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
    func testEscapedSenderNameIsCleanedForNewAndCachedMessages() throws {
        let email = "person@example.com"
        for name in [#"\"person@example.com\""#, #""person@example.com""#] {
            var message = FeatureService.item()
            message.sender = name
            message.senderAddress = email
            message.replyAddress = email
            message.senderName = name
            XCTAssertEqual(message.displaySender, email)
            let cached = try JSONDecoder().decode(MailSummary.self, from: JSONEncoder().encode(message))
            XCTAssertEqual(cached.displaySender, email)
            message.senderName = nil
            message.senderAddress = nil
            message.sender = name + " <" + email + ">"
            XCTAssertEqual(message.displaySender, email)
        }
        XCTAssertEqual(MailAddress(name: #"\"张三\""#, email: email).title, "张三")
        XCTAssertEqual(MailAddress.cleanedName(#""Jane \"JJ\" Doe""#, email: email), #"Jane "JJ" Doe"#)
        XCTAssertEqual(MailAddress.cleanedName(#"研发\支持"#, email: email), #"研发\支持"#)
        XCTAssertEqual(MailAddress.cleanedName("O'Connor", email: email), "O'Connor")
    }
    func testCorrespondenceMatchesExactParticipantsAndDeduplicatesMessages() throws {
        var incoming = FeatureService.item(); incoming.senderAddress = "sender@example.com"; incoming.messageID = "<same@example.com>"
        var duplicate = incoming.relocated(uid: 9, validity: 10, folder: "Archive")
        duplicate.date = Date(timeIntervalSince1970: 100)
        var outgoing = FeatureService.item(folder: "Sent"); outgoing.sender = "demo@example.com"; outgoing.replyAddress = "demo@example.com"
        outgoing.recipients = [.init(email: "SENDER@example.com")]
        var falseMatch = outgoing; falseMatch.recipients = [.init(email: "not-sender@example.com")]
        XCTAssertTrue(incoming.involves("sender@example.com")); XCTAssertTrue(outgoing.involves("sender@example.com"))
        XCTAssertFalse(falseMatch.involves("sender@example.com"))
        XCTAssertEqual(incoming.correspondent(ownAddress: "demo@example.com"), "sender@example.com")
        XCTAssertEqual(outgoing.correspondent(ownAddress: "demo@example.com"), "SENDER@example.com")
        incoming.senderAddress = "different@example.com"
        XCTAssertFalse(incoming.involves("sender@example.com"), "Reply-To alone is not a correspondence participant")
        let result = MailStore.correspondenceMessages([duplicate, duplicate, outgoing, falseMatch], address: "sender@example.com")
        XCTAssertEqual(result.count, 2)
    }
    func testCachedCorrespondenceIncludesSentAndRemainsAccountScoped() throws {
        let vault = FeatureVault(), files = try MailFiles(root: root)
        var first = MailAccount(); first.email = "demo@example.com"; first.suggestServers()
        var second = MailAccount(); second.email = "other@example.com"; second.suggestServers()
        vault.entries = [.init(account: first, password: "synthetic"), .init(account: second, password: "synthetic")]
        try files.write([MailFolder(name: "INBOX"), MailFolder(name: "Sent")], account: first.id, key: "folders")
        let incoming = FeatureService.item()
        var outgoing = FeatureService.item(folder: "Sent"); outgoing.sender = first.email; outgoing.replyAddress = first.email
        outgoing.recipients = [.init(email: "sender@example.com")]
        try files.write([incoming], account: first.id, key: "list:INBOX")
        try files.write([outgoing], account: first.id, key: "list:Sent")
        try files.write([incoming.relocated(uid: 99, validity: 10, folder: "INBOX")], account: second.id, key: "list:INBOX")
        let store = MailStore(vault: vault, files: files, service: FeatureService())
        XCTAssertEqual(Set(try store.cachedCorrespondence(with: "sender@example.com").map(\.folder)), ["INBOX", "Sent"])
        XCTAssertEqual(store.folder, "INBOX")
        try store.selectAccount(second.id)
        XCTAssertEqual(try store.cachedCorrespondence(with: "sender@example.com").map(\.uid), [99])
    }
    func testBatchMoveAndUndoUseEveryMappedDestinationUID() async throws {
        let (store, _, service, _) = try await setup()
        let items = [FeatureService.item(), FeatureService.item().relocated(uid: 8, validity: 10, folder: "INBOX")]
        try await store.perform(.move("Trash"), on: items)
        XCTAssertNotNil(store.undoID)
        try await store.undoLastAction(); store.cancelRefresh()
        let actions = await service.recordedActions(), uids = await service.recordedUIDs()
        XCTAssertEqual(actions, [.move("Trash"), .move("INBOX")])
        XCTAssertEqual(uids, [107, 108])
    }
    func testLegacyFolderDisplayDecodesWithoutChangingProtocolIdentity() {
        let raw = "&lpR5u1M6-", folder = MailFolder(name: raw)
        XCTAssertEqual(folder.title, "隔离区"); XCTAssertEqual(folder.name, raw); XCTAssertEqual(folder.id, raw)
        XCTAssertEqual(MailFolder(name: "~peter/mail/&U,BTFw-/&ZeVnLIqe-").title, "~peter/mail/台北/日本語")
        XCTAssertEqual(MailFolder(name: "R&-D").title, "R&D")
        XCTAssertEqual(MailFolder(name: "项目/资料").title, "项目/资料")
    }
    func testMalformedOrEncodedASCIIFolderNamesRemainLossless() {
        for name in ["R&D", "&broken", "&AEc-", "&AA-", "&AA=-", "&AAE-", "foo&!-bar"] { XCTAssertEqual(MailFolder(name: name).title, name) }
        var role = MailFolder(name: "&lpR5u1M6-"); role.role = "junk"
        XCTAssertEqual(role.title, "垃圾邮件"); XCTAssertEqual(role.name, "&lpR5u1M6-")
    }
    func testCorporateDeletedFolderNamesAreRecognizedWithoutGuessingOutbox() {
        for name in ["Trash", "Deleted Items", "已删除邮件", "已删除项目"] { XCTAssertEqual(MailFolder(name: name).title, "废纸篓") }
        XCTAssertNotEqual(MailFolder(name: "发件箱").title, "已发送")
    }
    func testServerCorrespondenceCachesWithoutSwitchingTheActiveFolder() async throws {
        let vault = FeatureVault(), files = try MailFiles(root: root), service = CorrespondenceTestService()
        var account = MailAccount(); account.email = "demo@example.com"; account.suggestServers()
        vault.entries = [.init(account: account, password: "synthetic")]
        let store = MailStore(vault: vault, files: files, service: service)
        let folders = try await store.correspondenceFolders()
        XCTAssertEqual(folders.map(\.name), ["INBOX", "Sent"])
        let result = try await store.correspondence(with: "peer@example.com", folder: "Sent", limit: 9999)
        XCTAssertEqual(result.messages.count, 1); XCTAssertEqual(store.folder, "INBOX"); XCTAssertTrue(store.messages.isEmpty)
        let recordedLimit = await service.lastLimit; XCTAssertEqual(recordedLimit, 500)
        let restored = MailStore(vault: vault, files: files, service: service)
        XCTAssertEqual(try restored.cachedCorrespondence(with: "peer@example.com").map(\.folder), ["Sent"])
    }
    func testAccountSwitchDiscardsInFlightCorrespondenceBeforeCacheWrite() async throws {
        let vault = FeatureVault(), files = try MailFiles(root: root), service = CorrespondenceTestService()
        var first = MailAccount(); first.email = "first@example.com"; first.suggestServers()
        var second = MailAccount(); second.email = "second@example.com"; second.suggestServers()
        vault.entries = [.init(account: first, password: "synthetic"), .init(account: second, password: "synthetic")]
        let store = MailStore(vault: vault, files: files, service: service)
        await service.hold()
        let query = Task { try await store.correspondence(with: "peer@example.com", folder: "Sent") }
        for _ in 0..<100 { if await service.started { break }; try await Task.sleep(for: .milliseconds(5)) }
        let started = await service.started; XCTAssertTrue(started)
        try store.selectAccount(second.id); await service.release()
        do { _ = try await query.value; XCTFail("A changed account must discard the query") }
        catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        for account in [first, second] {
            let cached = try files.read([MailSummary].self, account: account.id, key: "correspondence:peer@example.com:Sent")
            XCTAssertNil(cached)
        }
    }
    func testTrashCacheAndConfiguredTrashAreExcludedFromCorrespondenceEvenWhenActive() async throws {
        let vault = FeatureVault(), service = BulkCorrespondenceService(), files = try MailFiles(root: root)
        var account = MailAccount(); account.email = "demo@example.com"; account.trashFolder = "CorporateDeleted"; account.suggestServers()
        vault.entries = [.init(account: account, password: "synthetic-bulk-only")]
        try files.write([MailFolder(name: "INBOX"), MailFolder(name: "Archive"), MailFolder(name: "Trash"), MailFolder(name: "CorporateDeleted")], account: account.id, key: "folders")
        for folder in ["Archive", "Trash", "CorporateDeleted"] { try files.write([bulkItem(7, folder: folder)], account: account.id, key: "list:" + folder) }
        let store = MailStore(vault: vault, files: files, service: service)
        try store.selectFolder("CorporateDeleted")
        XCTAssertFalse(store.isCorrespondenceFolder("CorporateDeleted")); XCTAssertFalse(store.isCorrespondenceFolder("Trash"))
        XCTAssertEqual(try store.cachedCorrespondenceRecords(with: "peer@example.com").map(\.folder), ["Archive"])
        do { _ = try await store.moveCorrespondence([bulkItem(7, folder: "CorporateDeleted")], address: "peer@example.com", to: "Trash"); XCTFail("Already-deleted mail must not be moved again") } catch {}
        let moved = await service.moves; XCTAssertTrue(moved.isEmpty)
    }
    func testCorrespondenceBulkMoveGroupsFoldersAndUndoRestoresEverySource() async throws {
        let (store, service, files, account) = try await bulkSetup()
        let incoming = bulkItem(7), archived = bulkItem(7, folder: "Archive"), sent = bulkItem(8, folder: "Sent")
        for item in [incoming, archived, sent] {
            try files.write([item], account: account, key: "list:" + item.folder)
            try files.write([item], account: account, key: "correspondence:peer@example.com:" + item.folder)
        }
        let result = try await store.moveCorrespondence([incoming, incoming, archived, sent], address: "peer@example.com", to: "Trash")
        XCTAssertEqual(result.completed.count, 3); XCTAssertFalse(result.needsReconciliation)
        XCTAssertTrue(try store.cachedCorrespondenceRecords(with: "peer@example.com").isEmpty)
        XCTAssertNotNil(store.undoID); XCTAssertEqual(store.folder, "INBOX")
        try await store.undoLastAction(); store.cancelRefresh()
        let moves = await service.moves, undone = await service.undone
        XCTAssertEqual(moves.map { $0.0 }, ["Archive", "INBOX", "Sent"])
        XCTAssertEqual(Set(undone), ["Archive", "INBOX", "Sent"])
        XCTAssertEqual(moves.flatMap { $0.1 }.count, 3)
    }
    func testCorrespondenceBulkMoveStopsOnUncertainBatchAndDoesNotClaimUndo() async throws {
        let (store, service, files, account) = try await bulkSetup()
        await service.fail(folder: "INBOX")
        let records = [bulkItem(7, folder: "Archive"), bulkItem(7), bulkItem(8, folder: "Sent")]
        for item in records { try files.write([item], account: account, key: "list:" + item.folder) }
        let result = try await store.moveCorrespondence(records, address: "peer@example.com", to: "Trash")
        XCTAssertEqual(result.completed.map(\.folder), ["Archive"]); XCTAssertTrue(result.needsReconciliation)
        let calls = await service.moves
        XCTAssertEqual(calls.map { $0.0 }, ["Archive", "INBOX"], "Never retry the uncertain request or process later batches")
        XCTAssertNil(store.undoID)
        XCTAssertEqual(try files.read([MailSummary].self, account: account, key: "list:INBOX")?.count, 1)
    }
    func testCorrespondenceBulkMoveChunksLargeSelectionsAndRequiresAllMappingsForUndo() async throws {
        let (store, service, _, _) = try await bulkSetup()
        let result = try await store.moveCorrespondence((1...205).map { bulkItem(UInt32($0)) }, address: "peer@example.com", to: "Trash")
        XCTAssertEqual(result.completed.count, 205)
        let batches = await service.moves
        XCTAssertEqual(batches.map { $0.1.count }, [100, 100, 5]); XCTAssertNotNil(store.undoID)
        await service.omitReceipt()
        let noMapping = try await store.moveCorrespondence([bulkItem(999)], address: "peer@example.com", to: "Trash")
        XCTAssertEqual(noMapping.completed.count, 1); XCTAssertFalse(noMapping.needsReconciliation); XCTAssertNil(store.undoID)
    }
    func testCorrespondenceBulkMoveRejectsUnrelatedMailAndSameFolderBeforeMutation() async throws {
        let (store, service, _, _) = try await bulkSetup()
        var other = bulkItem(7); other.senderAddress = "not-peer@example.com"
        for (items, target) in [([other], "Trash"), ([bulkItem(7)], "INBOX")] {
            do { _ = try await store.moveCorrespondence(items, address: "peer@example.com", to: target); XCTFail("Invalid selection must not move") }
            catch {}
        }
        let moves = await service.moves; XCTAssertTrue(moves.isEmpty)
    }
    func testCorrespondencePaginationCanLoadBeyondFiveHundredAndCacheAllPhysicalRecords() async throws {
        let (store, service, _, _) = try await bulkSetup()
        await service.setRecords((1...601).map { bulkItem(UInt32($0)) })
        var before: UInt32?, found: [MailSummary] = []
        repeat {
            let result = try await store.correspondencePage(with: "peer@example.com", folder: "INBOX", beforeUID: before, limit: 200)
            found += result.messages; before = result.nextUID
        } while before != nil
        XCTAssertEqual(found.count, 601); XCTAssertEqual(Set(found.map(\.id)).count, 601)
        XCTAssertEqual(try store.cachedCorrespondenceRecords(with: "peer@example.com").count, 601)
        XCTAssertEqual(store.folder, "INBOX"); XCTAssertTrue(store.messages.isEmpty)
    }
    func testCorrespondencePaginationRejectsNonAdvancingCursor() async throws {
        let (store, service, _, _) = try await bulkSetup(); await service.repeatCursor()
        do { _ = try await store.correspondencePage(with: "peer@example.com", folder: "INBOX", beforeUID: 5, limit: 200); XCTFail("Nonadvancing cursor must fail") }
        catch {}
        XCTAssertTrue(try store.cachedCorrespondenceRecords(with: "peer@example.com").isEmpty)
    }
    private func bulkItem(_ uid: UInt32, folder: String = "INBOX") -> MailSummary {
        var item = MailSummary(uid: uid, validity: 10, folder: folder, subject: "合成往来", sender: "peer@example.com", replyAddress: "peer@example.com", date: nil, unread: false, messageID: "<peer-\(uid)@example.com>")
        item.senderAddress = "peer@example.com"; return item
    }
    private func bulkSetup() async throws -> (MailStore, BulkCorrespondenceService, MailFiles, UUID) {
        let vault = FeatureVault(), service = BulkCorrespondenceService(), files = try MailFiles(root: root)
        var account = MailAccount(); account.email = "demo@example.com"; account.suggestServers()
        vault.entries = [.init(account: account, password: "synthetic-bulk-only")]
        try files.write([MailFolder(name: "INBOX"), MailFolder(name: "Archive"), MailFolder(name: "Sent")], account: account.id, key: "folders")
        return (MailStore(vault: vault, files: files, service: service), service, files, account.id)
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
        message.sender = "\"张三\" <sender@example.com>"; message.senderName = "=?UTF-8?B?5byg5LiJ?="
        message.recipients = [.init(name: "李四", email: "li@example.com"), .init(name: "自己", email: "demo@example.com")]
        message.carbonCopies = [.init(name: "王五", email: "wang@example.com")]
        try files.write([message], account: account, key: "list:INBOX")
        try files.write([MailContact(email: "sender@example.com"), .init(email: "li@example.com", name: "手动姓名", note: "保留备注", manuallyEdited: true), .init(email: "wang@example.com", name: "=?UTF-8?B?546L5LqU?=")], account: account, key: "contacts")
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

private actor CorrespondenceTestService: MailService {
    var started = false
    var lastLimit = 0
    private var held = false
    private var continuation: CheckedContinuation<Void, Never>?
    func hold() { held = true }
    func release() { held = false; continuation?.resume(); continuation = nil }
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Sent"), .init(name: "Trash")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { [] }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult { .init(body: .init(text: "synthetic", html: nil), markedRead: false) }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws {}
    func correspondence(_ credential: AccountCredential, folder: String, address: String, limit: Int) async throws -> MailSearchResult {
        started = true; lastLimit = limit
        if held { await withCheckedContinuation { continuation = $0 } }
        let item = MailSummary(uid: 7, validity: 10, folder: folder, subject: "合成往来记录", sender: "peer@example.com", replyAddress: "peer@example.com", date: nil, unread: false)
        return MailSearchResult(messages: [item], total: 1)
    }
}

private actor BulkCorrespondenceService: MailService {
    var moves: [(String, [UInt32])] = []
    var undone: [String] = []
    var failedFolder: String?
    var noReceipt = false
    var badCursor = false
    var records: [MailSummary] = []
    var nextUID: UInt32 = 1000
    func fail(folder: String) { failedFolder = folder }
    func omitReceipt() { noReceipt = true }
    func repeatCursor() { badCursor = true }
    func setRecords(_ input: [MailSummary]) { records = input }
    func validate(_ credential: AccountCredential) async throws {}
    func folders(_ credential: AccountCredential) async throws -> [MailFolder] { [.init(name: "INBOX"), .init(name: "Sent")] }
    func summaries(_ credential: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] { [] }
    func read(_ credential: AccountCredential, summary: MailSummary) async throws -> ReadResult { .init(body: .init(text: "synthetic", html: nil), markedRead: false) }
    func send(_ credential: AccountCredential, draft: MailDraft) async throws {}
    func move(_ credential: AccountCredential, summaries: [MailSummary], to folder: String) async throws -> [MailSummary]? {
        XCTAssertTrue(summaries.allSatisfy { $0.folder == summaries.first?.folder && $0.validity == summaries.first?.validity })
        moves.append((summaries[0].folder, summaries.map(\.uid)))
        if failedFolder == summaries[0].folder { throw MailFailure.invalid("synthetic uncertain result") }
        if noReceipt { return nil }
        return summaries.map { nextUID += 1; return $0.relocated(uid: nextUID, validity: 20, folder: folder) }
    }
    func perform(_ credential: AccountCredential, summaries: [MailSummary], action: MailAction) async throws {
        XCTAssertTrue(summaries.allSatisfy { $0.folder == "Trash" && $0.validity == 20 })
        if case .move(let source) = action { undone.append(source) }
    }
    func correspondencePage(_ credential: AccountCredential, folder: String, address: String, beforeUID: UInt32?, limit: Int) async throws -> MailSearchResult {
        if badCursor { return .init(messages: [], total: 10, nextUID: beforeUID) }
        let all = records.filter { $0.folder == folder }.sorted { $0.uid > $1.uid }
        let remaining = all.filter { beforeUID == nil || $0.uid < beforeUID! }, page = Array(remaining.prefix(limit))
        return .init(messages: page, total: all.count, nextUID: remaining.count > page.count ? page.last?.uid : nil)
    }
}
