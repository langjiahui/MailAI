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
            let list = try await server.listMailboxes().filter(\.isSelectable).map { MailFolder(name: $0.name) }
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
            for try await info in server.fetchMessageInfos(using: range, options: .slim) {
                try Task.checkCancellation()
                guard let uid = info.uid else { continue }
                let reply = (info.replyToAddresses.mailboxes.first ?? info.fromAddresses.mailboxes.first)?.address ?? ""
                result.append(MailSummary(uid: uid.value, validity: selection.uidValidity.value, folder: folder,
                    subject: info.subject ?? "（无主题）", sender: info.from ?? "未知发件人", replyAddress: reply,
                    date: info.internalDate ?? info.date, unread: !info.flags.contains(.seen),
                    messageID: info.messageId?.description))
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
            let body = MailBody(text: message.textBody ?? "", html: message.htmlBody)
            var marked = false
            do { try await server.store(flags: [.seen], on: MessageIdentifierSet(uid), operation: .add); marked = true }
            catch { /* Reading succeeds even when the separate read-flag update is rejected. */ }
            return ReadResult(body: body, markedRead: marked)
        }
    }
    func send(_ entry: AccountCredential, draft: MailDraft) async throws {
        var editable = draft; editable.state = .editing
        let addresses = try editable.validateForSending()
        var email = Email(sender: EmailAddress(name: entry.account.displayName, address: entry.account.email),
            recipients: addresses.map { EmailAddress(address: $0) }, subject: draft.subject, textBody: draft.text)
        if let reply = draft.inReplyTo, !MailValidation.hasControl(reply), let parsed = MessageID(reply) {
            email.additionalHeaders = ["In-Reply-To": parsed.description, "References": parsed.description]
        }
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
