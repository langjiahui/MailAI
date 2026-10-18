package com.mailai.mobile.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.mailai.mobile.background.AppPreferences
import com.mailai.mobile.background.MailNotifications
import com.mailai.mobile.mail.*
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class MailRepository(
    private val context: Context,
    val accounts: AccountStore = AccountStore(context),
    private val transport: MailTransport = MailTransport(),
) {
    private val stores = ConcurrentHashMap<String, MailStore>()

    private val syncLocks = ConcurrentHashMap<String, Mutex>()

    fun store(a: Account): MailStore =
        stores.computeIfAbsent(a.id) { MailStore(context, a.id).apply { recoverInterrupted() } }

    fun accountDir(a: Account) =
        File(context.filesDir, "accounts/${UUID.fromString(a.id)}").apply { mkdirs() }

    fun file(a: Account, name: String): File {
        require(name.matches(Regex("[a-zA-Z0-9.-]+")) && !name.contains(".."))
        return File(accountDir(a), name)
    }

    suspend fun initialize(): List<Account> =
        withContext(Dispatchers.IO) { accounts.all().also { list -> list.forEach(::store) } }

    suspend fun add(a: Account, password: String, op: Operation, status: (String) -> Unit) =
        withContext(Dispatchers.IO) {
            require(password.isNotBlank()) { "请填写邮箱密码或授权码" }
            MimeCodec.addresses(a.email).also { require(it.size == 1) }
            require(accounts.all().none { it.email.equals(a.email, true) && it.id != a.id }) {
                "这个邮箱已经添加"
            }
            transport.verify(a, password, op, status)
            op.check()
            status("正在安全保存账户…")
            val previous = accounts.all().find { it.id == a.id }
            accounts.put(a, password)
            if (previous != null && (previous.imap != a.imap || previous.username != a.username))
                store(a).clearMessageCache()
            else store(a)
        }

    suspend fun folders(a: Account, op: Operation) =
        withContext(Dispatchers.IO) { transport.folders(a, accounts.password(a.id), op) }

    suspend fun sync(a: Account, folder: String, limit: Int, op: Operation) =
        withContext(Dispatchers.IO) {
            syncLocks
                .computeIfAbsent(a.id) { Mutex() }
                .withLock {
                    op.check()
                    val (validity, messages) =
                        transport.sync(
                            a,
                            accounts.password(a.id),
                            folder,
                            maxOf(limit, store(a).messages(folder).size),
                            op,
                        )
                    op.check()
                    val db = store(a)
                    db.replaceWindow(folder, validity, messages)
                    if (folder.equals("INBOX", true)) {
                        db.recordArrivals(validity, messages)
                        if (AppPreferences(context).background)
                            MailNotifications.show(context, a, db.pendingArrivals())
                        db.acknowledgeArrivals()
                        AppPreferences(context).syncResult(a.id, true)
                    }
                }
        }

    suspend fun read(a: Account, item: MailItem, op: Operation) =
        withContext(Dispatchers.IO) {
            val loaded =
                if (item.body != null) item
                else
                    transport.read(a, accounts.password(a.id), item, op).also {
                        op.check()
                        store(a).put(it)
                    }
            loaded
        }

    suspend fun seen(a: Account, item: MailItem, op: Operation) =
        withContext(Dispatchers.IO) {
            transport.seen(a, accounts.password(a.id), item, op)
            op.check()
            store(a).put(item.copy(unread = false))
        }

    suspend fun import(a: Account, uri: Uri, op: Operation): Attachment =
        withContext(Dispatchers.IO) {
            val resolver = context.contentResolver
            val name =
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    c ->
                    if (c.moveToFirst()) c.getString(0) else "附件"
                } ?: "附件"
            val token = UUID.randomUUID().toString()
            val pending = file(a, "$token.part")
            val dest = file(a, token)
            try {
                val size =
                    requireNotNull(resolver.openInputStream(uri)).use { input ->
                        pending.outputStream().use { output ->
                            MimeCodec.copyBounded(input, output, MAX_ATTACHMENT_BYTES, op)
                        }
                    }
                op.check()
                check(pending.renameTo(dest))
                Attachment(
                    "",
                    MimeCodec.fileName(name),
                    resolver.getType(uri) ?: "application/octet-stream",
                    size,
                    token,
                )
            } finally {
                pending.delete()
            }
        }

    suspend fun download(
        a: Account,
        item: MailItem,
        attachment: Attachment,
        op: Operation,
        progress: (Long) -> Unit,
    ): Pair<MailItem, Attachment> =
        withContext(Dispatchers.IO) {
            if (attachment.local.isNotBlank() && file(a, attachment.local).isFile)
                return@withContext item to attachment
            val token = UUID.randomUUID().toString()
            val pending = file(a, "$token.part")
            val dest = file(a, token)
            try {
                val size =
                    transport.download(
                        a,
                        accounts.password(a.id),
                        item,
                        attachment,
                        pending,
                        op,
                        progress,
                    )
                op.check()
                check(pending.renameTo(dest))
                val cached = attachment.copy(local = token, size = size)
                val next =
                    item.copy(
                        attachments =
                            item.attachments.map { if (it.part == attachment.part) cached else it }
                    )
                store(a).put(next)
                next to cached
            } finally {
                pending.delete()
            }
        }

    suspend fun send(a: Account, draft: Draft, op: Operation, status: (String) -> Unit): SendState =
        withContext(Dispatchers.IO) {
            val db = store(a)
            db.beginSend(draft)
            var submitted = false
            try {
                status("正在连接发件服务器…")
                transport.send(a, accounts.password(a.id), draft, { file(a, it) }, op) {
                    db.transition(draft.id, setOf(SendState.CONNECTING), SendState.TRANSMITTING)
                    submitted = true
                    status("正在提交邮件，请等待服务器确认…")
                }
                db.transition(draft.id, setOf(SendState.TRANSMITTING), SendState.SENT)
                SendState.SENT
            } catch (t: Throwable) {
                // SMTP after DATA may have succeeded despite a lost response. Never auto-retry.
                val state = if (submitted) SendState.UNCERTAIN else SendState.FAILED
                db.transition(draft.id, setOf(SendState.CONNECTING, SendState.TRANSMITTING), state)
                if (submitted) state else throw t
            }
        }
}
