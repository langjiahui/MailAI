package com.mailai.mobile.mail

import com.mailai.mobile.data.*
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPStore
import java.io.File
import java.net.InetAddress
import java.util.Properties
import javax.mail.*
import javax.mail.internet.InternetAddress
import javax.net.ssl.SSLSocketFactory

class MailLoginFailure(val stage: String, val host: String, cause: AuthenticationFailedException) :
    Exception("$stage 验证失败", cause)

class MailTransport
internal constructor(
    private val resolve: (String) -> InetAddress = NetworkPolicy::resolve,
    private val tls: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
) {
    private fun session(server: Server, protocol: String, op: Operation): Session {
        require(server.port in 1..65535)
        val address = resolve(server.host)
        op.check()
        val p =
            Properties().apply {
                setProperty("mail.$protocol.connectiontimeout", "15000")
                setProperty("mail.$protocol.timeout", "20000")
                setProperty("mail.$protocol.writetimeout", "20000")
                setProperty(
                    "mail.$protocol.ssl.enable",
                    (server.security == Security.TLS).toString(),
                )
                setProperty(
                    "mail.$protocol.starttls.enable",
                    (server.security == Security.STARTTLS).toString(),
                )
                setProperty(
                    "mail.$protocol.starttls.required",
                    (server.security == Security.STARTTLS).toString(),
                )
                // Hostname verification is enforced by PinnedTlsFactory/JSSE against server.host.
                // JavaMail sees the pinned IP, so its second hostname check would be incorrect.
                setProperty("mail.$protocol.ssl.checkserveridentity", "false")
                setProperty("mailai.connectHost", address.hostAddress)
                setProperty("mail.$protocol.ssl.protocols", "TLSv1.2 TLSv1.3")
                setProperty("mail.$protocol.socketFactory.fallback", "false")
                put("mail.$protocol.socketFactory", PinnedSocketFactory(address, op))
                put(
                    "mail.$protocol.ssl.socketFactory",
                    PinnedTlsFactory(server.host, address, op, tls),
                )
                setProperty("mail.smtp.auth", "true")
                setProperty("mail.smtp.sendpartial", "false")
                setProperty("mail.smtp.quitwait", "false")
                setProperty("mail.imap.peek", "true")
                setProperty("mail.imap.fetchsize", "65536")
                setProperty("mail.imap.connectionpoolsize", "1")
                setProperty("mail.mime.decodefilename", "true")
            }
        return Session.getInstance(p)
    }

    private fun <T> imap(a: Account, password: String, op: Operation, block: (IMAPStore) -> T): T {
        val session = session(a.imap, "imap", op)
        val store = session.getStore("imap") as IMAPStore
        try {
            store.connect(
                session.getProperty("mailai.connectHost"),
                a.imap.port,
                a.username,
                password,
            )
            op.check()
            return block(store)
        } finally {
            runCatching { store.close() }
        }
    }

    fun verify(a: Account, password: String, op: Operation, status: (String) -> Unit) {
        status("正在验证收信服务器…")
        try {
            imap(a, password, op) {
                it.getFolder("INBOX").let { f ->
                    f.open(Folder.READ_ONLY)
                    f.close(false)
                }
            }
        } catch (e: AuthenticationFailedException) {
            throw MailLoginFailure("收信", a.imap.host, e)
        }
        op.check()
        status("正在验证发信服务器…")
        val session = session(a.smtp, "smtp", op)
        val transport = session.getTransport("smtp")
        try {
            transport.connect(
                session.getProperty("mailai.connectHost"),
                a.smtp.port,
                a.username,
                password,
            )
            op.check()
        } catch (e: AuthenticationFailedException) {
            throw MailLoginFailure("发信", a.smtp.host, e)
        } finally {
            runCatching { transport.close() }
        }
    }

    fun folders(a: Account, password: String, op: Operation): List<String> =
        imap(a, password, op) { store ->
            store.defaultFolder
                .list("*")
                .filter { it.type and Folder.HOLDS_MESSAGES != 0 }
                .map { it.fullName }
                .sortedBy { if (it.equals("INBOX", true)) "" else it }
        }

    private fun envelope(folder: IMAPFolder, m: Message): MailItem {
        val uid = folder.getUID(m)
        val validity = folder.uidValidity
        return MailItem(
            "${folder.fullName}:$validity:$uid",
            folder.fullName,
            validity,
            uid,
            m.from
                ?.joinToString { (it as? InternetAddress)?.toUnicodeString() ?: it.toString() }
                .orEmpty(),
            m.replyTo
                ?.joinToString { (it as? InternetAddress)?.address ?: it.toString() }
                .orEmpty(),
            MailAddresses.display(
                m.getRecipients(Message.RecipientType.TO)?.joinToString().orEmpty()
            ),
            m.subject ?: "（无主题）",
            (m.sentDate ?: m.receivedDate)?.time ?: 0L,
            !m.isSet(Flags.Flag.SEEN),
            messageId = m.getHeader("Message-ID")?.firstOrNull().orEmpty(),
            cc =
                MailAddresses.display(
                    m.getRecipients(Message.RecipientType.CC)?.joinToString().orEmpty()
                ),
        )
    }

    fun sync(
        a: Account,
        password: String,
        folder: String,
        limit: Int,
        op: Operation,
    ): Pair<Long, List<MailItem>> =
        imap(a, password, op) { store ->
            val f = store.getFolder(folder) as IMAPFolder
            try {
                f.open(Folder.READ_ONLY)
                val count = f.messageCount
                val messages =
                    if (count == 0) emptyArray()
                    else f.getMessages(maxOf(1, count - limit + 1), count)
                f.fetch(
                    messages,
                    FetchProfile().apply {
                        add(FetchProfile.Item.ENVELOPE)
                        add(FetchProfile.Item.FLAGS)
                        add(UIDFolder.FetchProfileItem.UID)
                        add("Message-ID")
                    },
                )
                f.uidValidity to
                    messages.map {
                        op.check()
                        envelope(f, it)
                    }
            } finally {
                if (f.isOpen) f.close(false)
            }
        }

    private fun <T> existing(
        a: Account,
        password: String,
        item: MailItem,
        op: Operation,
        write: Boolean = false,
        block: (Message) -> T,
    ): T =
        imap(a, password, op) { store ->
            val f = store.getFolder(item.folder) as IMAPFolder
            try {
                f.open(if (write) Folder.READ_WRITE else Folder.READ_ONLY)
                check(f.uidValidity == item.validity) { "邮箱索引已变化，请刷新列表后重试" }
                val m = requireNotNull(f.getMessageByUID(item.uid)) { "邮件已被移动或删除，请刷新列表" }
                block(m)
            } finally {
                if (f.isOpen) f.close(false)
            }
        }

    fun read(
        a: Account,
        password: String,
        item: MailItem,
        op: Operation,
        inline: ((Attachment, Part) -> Attachment)? = null,
    ): MailItem =
        existing(a, password, item, op) { m ->
            val content = MimeCodec.content(m)
            val files =
                content.files.map { file ->
                    if (
                        inline != null &&
                            file.contentId.isNotBlank() &&
                            file.type.startsWith("image/") &&
                            content.html != null
                    ) {
                        try {
                            inline(file, MimeCodec.part(m, file.part))
                        } catch (e: java.util.concurrent.CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            file
                        }
                    } else file
                }
            op.check()
            envelope(m.folder as IMAPFolder, m)
                .copy(
                    body = content.text,
                    attachments = files,
                    html = content.html,
                    contentVersion = 1,
                )
        }

    fun seen(a: Account, password: String, item: MailItem, op: Operation) =
        existing(a, password, item, op, true) { it.setFlag(Flags.Flag.SEEN, true) }

    fun download(
        a: Account,
        password: String,
        item: MailItem,
        attachment: Attachment,
        dest: File,
        op: Operation,
        progress: (Long) -> Unit,
    ): Long =
        existing(a, password, item, op) { message ->
            val part = MimeCodec.part(message, attachment.part)
            require(part.size <= MAX_ATTACHMENT_BYTES) { "附件超过 25 MB 限制" }
            part.inputStream.use { input ->
                dest.outputStream().use { output ->
                    MimeCodec.copyBounded(input, output, MAX_ATTACHMENT_BYTES, op, progress)
                }
            }
        }

    /** onSubmitting must durably record TRANSMITTING before DATA can leave this process. */
    fun send(
        a: Account,
        password: String,
        draft: Draft,
        file: (String) -> File,
        op: Operation,
        onSubmitting: () -> Unit,
    ) {
        val s = session(a.smtp, "smtp", op)
        val message = MimeCodec.outgoing(s, a, draft, file)
        val transport = s.getTransport("smtp")
        try {
            transport.connect(
                s.getProperty("mailai.connectHost"),
                a.smtp.port,
                a.username,
                password,
            )
            op.check()
            onSubmitting()
            transport.sendMessage(message, message.allRecipients)
        } finally {
            runCatching { transport.close() }
        }
    }
}
