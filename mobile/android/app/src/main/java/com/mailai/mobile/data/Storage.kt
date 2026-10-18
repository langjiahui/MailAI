package com.mailai.mobile.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

internal fun attachmentsJson(items: List<Attachment>) =
    JSONArray().apply {
        items.forEach {
            put(
                JSONObject()
                    .put("part", it.part)
                    .put("name", it.name)
                    .put("type", it.type)
                    .put("size", it.size)
                    .put("local", it.local)
            )
        }
    }

internal fun attachments(a: JSONArray): List<Attachment> =
    (0 until a.length()).map {
        a.getJSONObject(it).let {
            Attachment(
                it.getString("part"),
                it.getString("name"),
                it.getString("type"),
                it.getLong("size"),
                it.getString("local"),
            )
        }
    }

internal fun draftJson(d: Draft) =
    JSONObject()
        .put("id", d.id)
        .put("to", d.to)
        .put("subject", d.subject)
        .put("body", d.body)
        .put("files", attachmentsJson(d.attachments))
        .put("state", d.state.name)
        .put("messageId", d.messageId)
        .put("replyId", d.replyId)
        .put("updated", d.updated)

internal fun draftFrom(j: JSONObject) =
    Draft(
        j.getString("id"),
        j.getString("to"),
        j.getString("subject"),
        j.getString("body"),
        attachments(j.getJSONArray("files")),
        SendState.valueOf(j.getString("state")),
        j.getString("messageId"),
        j.getString("replyId"),
        j.getLong("updated"),
    )

internal fun mailJson(m: MailItem) =
    JSONObject()
        .put("key", m.key)
        .put("folder", m.folder)
        .put("validity", m.validity)
        .put("uid", m.uid)
        .put("sender", m.sender)
        .put("replyTo", m.replyTo)
        .put("recipients", m.recipients)
        .put("subject", m.subject)
        .put("date", m.date)
        .put("unread", m.unread)
        .put("body", m.body ?: JSONObject.NULL)
        .put("files", attachmentsJson(m.attachments))
        .put("messageId", m.messageId)

internal fun mailFrom(j: JSONObject) =
    MailItem(
        j.getString("key"),
        j.getString("folder"),
        j.getLong("validity"),
        j.getLong("uid"),
        j.getString("sender"),
        j.getString("replyTo"),
        j.getString("recipients"),
        j.getString("subject"),
        j.getLong("date"),
        j.getBoolean("unread"),
        if (j.isNull("body")) null else j.getString("body"),
        attachments(j.getJSONArray("files")),
        j.getString("messageId"),
    )

interface SecretCipher {
    fun encrypt(text: String): String

    fun decrypt(text: String): String
}

class DeviceCipher : SecretCipher {
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("mailai.credentials.v1", null) as? SecretKey)?.let {
            return it
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                            "mailai.credentials.v1",
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build()
                )
            }
            .generateKey()
    }

    override fun encrypt(text: String): String {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(
            cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)),
            Base64.NO_WRAP,
        )
    }

    override fun decrypt(text: String): String {
        val bytes = Base64.decode(text, Base64.NO_WRAP)
        require(bytes.size >= 28)
        return Cipher.getInstance("AES/GCM/NoPadding")
            .apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            }
            .doFinal(bytes.copyOfRange(12, bytes.size))
            .toString(Charsets.UTF_8)
    }
}

class AccountStore(context: Context, private val cipher: SecretCipher = DeviceCipher()) {
    private val file = AtomicFile(File(context.filesDir, "accounts.json"))

    private fun raw(): JSONArray =
        if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists())
            JSONArray(file.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
        else JSONArray()

    private fun server(j: JSONObject) =
        Server(j.getString("host"), j.getInt("port"), Security.valueOf(j.getString("security")))

    @Synchronized
    fun all(): List<Account> =
        raw().let { a ->
            (0 until a.length()).map {
                a.getJSONObject(it).let { j ->
                    Account(
                        j.getString("id"),
                        j.getString("email"),
                        j.getString("name"),
                        j.getString("username"),
                        server(j.getJSONObject("imap")),
                        server(j.getJSONObject("smtp")),
                    )
                }
            }
        }

    @Synchronized
    fun password(id: String): String =
        raw().let { a ->
            (0 until a.length())
                .map { a.getJSONObject(it) }
                .first { it.getString("id") == id }
                .getString("secret")
                .let(cipher::decrypt)
        }

    @Synchronized
    fun put(account: Account, password: String) {
        require(all().none { it.id == account.id && !it.email.equals(account.email, true) }) {
            "更换邮箱地址请添加新账户"
        }
        require(all().none { it.id != account.id && it.email.equals(account.email, true) }) {
            "这个邮箱已经添加，请在账户中更新登录信息"
        }
        fun endpoint(s: Server) =
            JSONObject().put("host", s.host).put("port", s.port).put("security", s.security.name)
        val next = JSONArray()
        val old = raw()
        for (i in 0 until old.length()) if (old.getJSONObject(i).getString("id") != account.id)
            next.put(old.getJSONObject(i))
        next.put(
            JSONObject()
                .put("id", account.id)
                .put("email", account.email)
                .put("name", account.name)
                .put("username", account.username)
                .put("imap", endpoint(account.imap))
                .put("smtp", endpoint(account.smtp))
                .put("secret", cipher.encrypt(password))
        )
        val stream = file.startWrite()
        try {
            stream.write(next.toString().toByteArray())
            file.finishWrite(stream)
        } catch (t: Throwable) {
            file.failWrite(stream)
            throw t
        }
    }
}

/** One database per account. No destructive migration or fallback-to-empty on errors. */
class MailStore(context: Context, id: String) :
    SQLiteOpenHelper(context, "mail-${java.util.UUID.fromString(id)}.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        createNotificationTables(db)
        db.execSQL(
            "CREATE TABLE messages (key TEXT PRIMARY KEY, folder TEXT NOT NULL, date INTEGER NOT NULL, payload TEXT NOT NULL)"
        )
        db.execSQL(
            "CREATE TABLE drafts (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        if (old < 2) createNotificationTables(db)
        check(new == 2) { "需要受支持的数据库迁移" }
    }

    private fun createNotificationTables(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS arrival_cursor (folder TEXT PRIMARY KEY, validity INTEGER NOT NULL, uid INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS arrival_pending (key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
    }

    /** First sync and UIDVALIDITY changes establish a baseline without alerting old mail. */
    @Synchronized
    fun recordArrivals(validity: Long, incoming: List<MailItem>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val previous = db.rawQuery("SELECT validity,uid FROM arrival_cursor WHERE folder='INBOX'", null).use {
                if (it.moveToFirst()) it.getLong(0) to it.getLong(1) else null
            }
            if (previous?.first != validity) db.delete("arrival_pending", null, null)
            else incoming.filter { it.unread && it.uid > previous.second }.forEach { m ->
                db.insertWithOnConflict("arrival_pending", null, ContentValues().apply {
                    put("key", m.key); put("payload", mailJson(m).toString())
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
            val high = maxOf(incoming.maxOfOrNull { it.uid } ?: 0L, if (previous?.first == validity) previous.second else 0L)
            db.insertWithOnConflict("arrival_cursor", null, ContentValues().apply {
                put("folder", "INBOX"); put("validity", validity); put("uid", high)
            }, SQLiteDatabase.CONFLICT_REPLACE)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized fun pendingArrivals(): List<MailItem> = readableDatabase.rawQuery("SELECT payload FROM arrival_pending", null).use { c ->
        buildList { while (c.moveToNext()) add(mailFrom(JSONObject(c.getString(0)))) }
    }
    @Synchronized fun acknowledgeArrivals() { writableDatabase.delete("arrival_pending", null, null) }

    @Synchronized
    fun clearMessageCache() {
        writableDatabase.delete("messages", null, null)
        writableDatabase.delete("arrival_cursor", null, null)
        writableDatabase.delete("arrival_pending", null, null)
    }

    @Synchronized
    fun messages(folder: String) =
        readableDatabase
            .rawQuery(
                "SELECT payload FROM messages WHERE folder=? ORDER BY date DESC",
                arrayOf(folder),
            )
            .use { c ->
                buildList { while (c.moveToNext()) add(mailFrom(JSONObject(c.getString(0)))) }
            }

    @Synchronized
    fun put(m: MailItem) {
        writableDatabase
            .insertWithOnConflict(
                "messages",
                null,
                ContentValues().apply {
                    put("key", m.key)
                    put("folder", m.folder)
                    put("date", m.date)
                    put("payload", mailJson(m).toString())
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            .also { check(it != -1L) }
    }

    @Synchronized
    fun replaceWindow(folder: String, validity: Long, incoming: List<MailItem>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val previous = messages(folder).associateBy { it.key }
            // This is a bounded latest-window cache, not an unchecked incremental cursor.
            db.delete("messages", "folder=?", arrayOf(folder))
            incoming.forEach { m ->
                val old = previous[m.key]
                put(
                    if (old?.validity == validity)
                        m.copy(body = old.body, attachments = old.attachments)
                    else m
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun drafts() =
        readableDatabase.rawQuery("SELECT payload FROM drafts ORDER BY updated DESC", null).use { c
            ->
            buildList { while (c.moveToNext()) add(draftFrom(JSONObject(c.getString(0)))) }
        }

    @Synchronized fun draft(id: String) = drafts().find { it.id == id }

    @Synchronized
    fun save(d: Draft) {
        val current = draft(d.id)
        check(current == null || current.state in setOf(SendState.DRAFT, SendState.FAILED)) {
            "邮件已进入发送流程，不能覆盖"
        }
        writeDraft(d.copy(updated = System.currentTimeMillis()))
    }

    private fun writeDraft(d: Draft) {
        writableDatabase
            .insertWithOnConflict(
                "drafts",
                null,
                ContentValues().apply {
                    put("id", d.id)
                    put("updated", d.updated)
                    put("state", d.state.name)
                    put("payload", draftJson(d).toString())
                },
                SQLiteDatabase.CONFLICT_REPLACE,
            )
            .also { check(it != -1L) }
    }

    @Synchronized
    fun transition(id: String, expected: Set<SendState>, next: SendState): Draft {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val current = requireNotNull(draft(id))
            check(current.state in expected) { "这封邮件已在处理中，请勿重复发送" }
            val updated = current.copy(state = next, updated = System.currentTimeMillis())
            writeDraft(updated)
            db.setTransactionSuccessful()
            return updated
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun recoverInterrupted() {
        drafts().forEach { d ->
            when (d.state) {
                SendState.CONNECTING -> transition(d.id, setOf(d.state), SendState.FAILED)
                SendState.TRANSMITTING -> transition(d.id, setOf(d.state), SendState.UNCERTAIN)
                else -> Unit
            }
        }
    }

    @Synchronized
    fun discard(id: String) {
        check(draft(id)?.state in setOf(SendState.DRAFT, SendState.FAILED))
        writableDatabase.delete("drafts", "id=?", arrayOf(id))
    }
}
