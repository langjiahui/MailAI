import Foundation
import SwiftMail
import MailAICore

struct NativeMailService: MailService {
    private func security(_ value: TransportSecurity) -> MailTransportSecurity {
        value == .tls ? .implicitTLS : .startTLS
    }
    private func withIMAP<T: Sendable>(_ entry: AccountCredential,
        action: @Sendable (IMAPServer) async throws -> T) async throws -> T {
        let a = entry.account
        let server = IMAPServer(host: a.imapHost, port: a.imapPort,
            transportSecurity: security(a.imapSecurity), certificateVerificationPolicy: .fullVerification,
            minimumTLSVersion: .tlsv12)
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                try await server.connect()
                try await server.login(username: a.username, password: entry.password)
                let result = try await action(server)
                try? await server.disconnect()
                return result
            } catch { try? await server.disconnect(); throw error }
        } onCancel: { Task { try? await server.disconnect() } }
    }
    private func smtp(_ entry: AccountCredential) -> SMTPServer {
        let a = entry.account
        return SMTPServer(host: a.smtpHost, port: a.smtpPort,
            transportSecurity: security(a.smtpSecurity), certificateVerificationPolicy: .fullVerification,
            minimumTLSVersion: .tlsv12,
            submissionTimeouts: SMTPSubmissionTimeouts(contentUpload: 90, contentResponse: 120))
    }
    func validate(_ entry: AccountCredential) async throws {
        try await withIMAP(entry) { server in _ = try await server.examineMailbox("INBOX") }
        let server = smtp(entry)
        try await withTaskCancellationHandler {
            do {
                try await server.connect()
                try await server.login(username: entry.account.username, password: entry.password)
                try? await server.disconnect()
            } catch { try? await server.disconnect(); throw error }
        } onCancel: { Task { try? await server.disconnect() } }
    }
    func folders(_ entry: AccountCredential) async throws -> [MailFolder] {
        try await withIMAP(entry) { server in
            let list = try await server.listMailboxes().filter(\.isSelectable).map { item in
                var folder = MailFolder(name: item.name)
                if item.attributes.contains(.sent) { folder.role = "sent" }
                else if item.attributes.contains(.trash) { folder.role = "trash" }
                else if item.attributes.contains(.archive) || item.attributes.contains(.all) { folder.role = "archive" }
                else if item.attributes.contains(.drafts) { folder.role = "drafts" }
                else if item.attributes.contains(.junk) { folder.role = "junk" }
                return folder
            }
            return list.sorted { a, b in
                if a.name.uppercased() == "INBOX" { return true }
                if b.name.uppercased() == "INBOX" { return false }
                return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
        }
    }
    func summaries(_ entry: AccountCredential, folder: String, limit: Int) async throws -> [MailSummary] {
        try await withIMAP(entry) { server in
            let selection = try await server.examineMailbox(folder)
            guard let range = selection.latest(limit) else { return [] }
            var result: [MailSummary] = []
            for try await info in server.fetchMessageInfos(using: range, options: .slim.union(.bodyStructure)) {
                try Task.checkCancellation()
                guard let uid = info.uid else { continue }
                result.append(Self.summary(info, uid: uid.value, validity: selection.uidValidity.value, folder: folder))
            }
            return result.sorted { $0.uid > $1.uid }
        }
    }
    func read(_ entry: AccountCredential, summary: MailSummary) async throws -> ReadResult {
        try await withIMAP(entry) { server in
            let selection = try await server.selectMailbox(summary.folder)
            guard selection.uidValidity.value == summary.validity else { throw MailFailure.changedMailbox }
            let uid = UID(summary.uid)
            guard let info = try await server.fetchMessageInfo(for: uid, options: [.envelope, .bodyStructure]) else {
                throw MailFailure.invalid("这封邮件已不在服务器上，请刷新列表。")
            }
            // Fetch only this message's own displayable bodies; never download attachments implicitly.
            let candidates = Message(header: info, parts: info.parts).bodies
            let chosen = [candidates.first { $0.contentType.lowercased().hasPrefix("text/plain") },
                          candidates.first { $0.contentType.lowercased().hasPrefix("text/html") }].compactMap { $0 }
            var parts: [MessagePart] = []
            for var part in chosen {
                try Task.checkCancellation()
                guard (part.size ?? 0) <= 2_000_000 else { throw MailFailure.invalid("这封邮件正文超过首版的 2 MB 限制。") }
                let raw = try await server.fetchPart(section: part.section, of: uid, offset: 0, count: 2_000_001)
                guard raw.count <= 2_000_000 else { throw MailFailure.invalid("这封邮件正文超过首版的 2 MB 限制。") }
                part.data = raw
                parts.append(part)
            }
            let message = Message(header: info, parts: parts)
            let metadata = Message(header: info, parts: info.parts).attachments.map {
                MailAttachment(id: $0.section.description, name: $0.suggestedFilename, mimeType: $0.contentType, size: $0.size ?? 0)
            }
            let body = MailBody(text: message.textBody ?? "", html: message.htmlBody, attachments: metadata,
                recipients: Self.addresses(info.toAddresses.mailboxes), carbonCopies: Self.addresses(info.ccAddresses.mailboxes))
            var marked = false
            do { try await server.store(flags: [.seen], on: MessageIdentifierSet(uid), operation: .add); marked = true }
            catch { /* Reading succeeds even when the separate read-flag update is rejected. */ }
            return ReadResult(body: body, markedRead: marked)
        }
    }
    private static func addresses(_ values: [EmailAddress]) -> [MailAddress] {
        values.map { MailAddress(name: $0.name ?? "", email: $0.address) }
    }
    private static func summary(_ info: MessageInfo, uid: UInt32, validity: UInt32, folder: String) -> MailSummary {
        let reply = (info.replyToAddresses.mailboxes.first ?? info.fromAddresses.mailboxes.first)?.address ?? ""
        var value = MailSummary(uid: uid, validity: validity, folder: folder,
            subject: info.subject ?? "（无主题）", sender: info.from ?? "未知发件人", replyAddress: reply,
            date: info.internalDate ?? info.date, unread: !info.flags.contains(.seen), messageID: info.messageId?.description)
        value.recipients = addresses(info.toAddresses.mailboxes); value.carbonCopies = addresses(info.ccAddresses.mailboxes)
        value.senderName = info.fromAddresses.mailboxes.first?.name
        value.isFlagged = info.flags.contains(.flagged)
        value.hasAttachments = !Message(header: info, parts: info.parts).attachments.isEmpty
        value.references = info.references?.map(\.description).joined(separator: " ")
        return value
    }
    private static func email(_ entry: AccountCredential, draft: MailDraft) throws -> Email {
        var editable = draft; editable.state = .editing
        _ = try editable.validateForSending()
        let groups = try draft.recipientGroups()
        let attachments = try draft.attachments.map { item -> Attachment in
            guard let data = item.data else { throw MailFailure.invalid("附件数据不可用。") }
            return Attachment(filename: MailAttachment.safeName(item.name), mimeType: item.mimeType, data: data)
        }
        var email = Email(sender: EmailAddress(name: entry.account.displayName, address: entry.account.email),
            recipients: groups.to.map { EmailAddress(address: $0) }, ccRecipients: groups.cc.map { EmailAddress(address: $0) },
            bccRecipients: groups.bcc.map { EmailAddress(address: $0) }, subject: draft.subject, textBody: draft.text,
            htmlBody: draft.html, attachments: attachments)
        email.messageID = MessageID("<\(draft.id)@mailai.local>")
        if let reply = draft.inReplyTo, !MailValidation.hasControl(reply), let parsed = MessageID(reply) {
            email.additionalHeaders = ["In-Reply-To": parsed.description, "References": parsed.description]
        }
        return email
    }
    func attachment(_ entry: AccountCredential, summary: MailSummary, attachment: MailAttachment) async throws -> Data {
        try await withIMAP(entry) { server in
            let selection = try await server.examineMailbox(summary.folder)
            guard selection.uidValidity.value == summary.validity else { throw MailFailure.changedMailbox }
            let uid = UID(summary.uid)
            guard let info = try await server.fetchMessageInfo(for: uid, options: [.bodyStructure]),
                  var part = Message(header: info, parts: info.parts).attachments.first(where: { $0.section.description == attachment.id }) else {
                throw MailFailure.invalid("附件已不存在，请刷新原邮件。")
            }
            let encodedLimit = 22_000_000
            guard (part.size ?? 0) <= encodedLimit else { throw MailFailure.invalid("附件超过 15 MB 限制。") }
            part.data = try await server.fetchPart(section: part.section, of: uid, offset: 0, count: encodedLimit + 1)
            guard (part.data?.count ?? 0) <= encodedLimit, let data = part.decodedData(), data.count <= MailAttachment.singleLimit else {
                throw MailFailure.invalid("附件过大或无法解码。")
            }
            return data
        }
    }
    func perform(_ entry: AccountCredential, summaries: [MailSummary], action: MailAction) async throws {
        guard let first = summaries.first else { return }
        guard summaries.allSatisfy({ $0.folder == first.folder && $0.validity == first.validity }) else { throw MailFailure.changedMailbox }
        try await withIMAP(entry) { server in
            let selection = try await server.selectMailbox(first.folder)
            guard selection.uidValidity.value == first.validity else { throw MailFailure.changedMailbox }
            let ids = UIDSet(summaries.map { UID($0.uid) })
            switch action {
            case .read(let value): try await server.store(flags: [.seen], on: ids, operation: value ? .add : .remove)
            case .flagged(let value): try await server.store(flags: [.flagged], on: ids, operation: value ? .add : .remove)
            case .move(let target):
                guard target != first.folder, !MailValidation.hasControl(target) else { throw MailFailure.invalid("请选择其他文件夹。") }
                _ = try await server.move(messages: ids, to: target)
            }
        }
    }
    func search(_ entry: AccountCredential, folder: String, query: String, limit: Int) async throws -> MailSearchResult {
        guard !query.isEmpty, query.count <= 256, !MailValidation.hasControl(query) else { throw MailFailure.invalid("请输入 1 至 256 字的搜索内容。") }
        return try await withIMAP(entry) { server in
            let selection = try await server.examineMailbox(folder)
            let result: ExtendedSearchResult<UID> = try await server.extendedSearch(criteria: [.text(query)])
            let all = result.all?.toArray().sorted { $0.value > $1.value } ?? []
            let chosen = Array(all.prefix(limit))
            guard !chosen.isEmpty else { return MailSearchResult(messages: [], total: 0) }
            var messages: [MailSummary] = []
            for try await info in server.fetchMessageInfos(using: UIDSet(chosen), options: .slim.union(.bodyStructure)) {
                if let uid = info.uid { messages.append(Self.summary(info, uid: uid.value, validity: selection.uidValidity.value, folder: folder)) }
            }
            return MailSearchResult(messages: messages.sorted { $0.uid > $1.uid }, total: all.count)
        }
    }
    func archiveSent(_ entry: AccountCredential, draft: MailDraft) async throws {
        let email = try Self.email(entry, draft: draft)
        try await withIMAP(entry) { server in
            _ = try await server.listSpecialUseMailboxes()
            let target = try entry.account.sentFolder ?? server.sentFolder.name
            _ = try await server.examineMailbox(target)
            let found: ExtendedSearchResult<UID> = try await server.extendedSearch(criteria: [.header("Message-ID", "<\(draft.id)@mailai.local>")])
            if found.all?.toArray().isEmpty == false { return }
            _ = try await server.append(email: email, to: target, flags: [.seen])
        }
    }
    func send(_ entry: AccountCredential, draft: MailDraft) async throws {
        let email = try Self.email(entry, draft: draft)
        let server = smtp(entry)
        do {
            try await server.connect()
            try await server.login(username: entry.account.username, password: entry.password)
        } catch {
            try? await server.disconnect()
            throw SubmissionFailure(uncertain: false)
        }
        do {
            _ = try await server.sendEmail(email)
            try? await server.disconnect()
        } catch let error as SMTPSendError {
            try? await server.disconnect()
            throw SubmissionFailure(uncertain: error.retryDisposition == .unsafeToRetry)
        } catch {
            try? await server.disconnect()
            throw SubmissionFailure(uncertain: true)
        }
    }
}
