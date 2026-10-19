package com.mailai.mobile

import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.MailContact
import java.util.UUID
import javax.mail.internet.MimeUtility
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class ContactInitializationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val cipher =
        object : SecretCipher {
            override fun encrypt(text: String) = text

            override fun decrypt(text: String) = text
        }

    private fun mail(uid: Long = 1, date: Long = uid) =
        MailItem(
            "INBOX:1:$uid",
            "INBOX",
            1,
            uid,
            "sender@example.test",
            "sender@example.test",
            "recipient@example.test",
            "测试邮件",
            date,
            true,
            "原始正文不能改写",
        )

    private fun insertRaw(db: SQLiteDatabase, item: MailItem) {
        db.execSQL(
            "INSERT INTO messages VALUES(?,?,?,?)",
            arrayOf<Any>(item.key, item.folder, item.date, mailJson(item).toString()),
        )
    }

    @Test
    fun accountInitializationBackfillsAllFoldersEvenWithExistingContacts() = runBlocking {
        val account =
            Account(
                email = "fixture@example.test",
                imap = Server("example.test", 993),
                smtp = Server("example.test", 465),
            )
        val accounts = AccountStore(context, cipher).apply { put(account, "synthetic-only") }
        val encoded = MimeUtility.encodeText("陈乐媛", "UTF-8", "B")
        val draft =
            Draft(
                to = "to@example.test",
                cc = "抄送同事 <cc@example.test>",
                bcc = "密送同事 <bcc@example.test>",
            )
        MailStore(context, account.id).use { store ->
            store.saveContact(MailContact("manual@example.test", "手动姓名"))
            val db = store.writableDatabase
            db.beginTransaction()
            try {
                // The useful name is older than the previous 500-mail lazy lookup window.
                insertRaw(db, mail(1).copy(recipients = "\"$encoded\" <chen@example.test>"))
                for (i in 2L..601L) insertRaw(db, mail(i))
                insertRaw(
                    db,
                    mail(700)
                        .copy(
                            key = "Sent:1:700",
                            folder = "Sent",
                            recipients = "已发送联系人 <sent@example.test>",
                        ),
                )
                db.execSQL(
                    "INSERT INTO drafts VALUES(?,?,?,?)",
                    arrayOf<Any>(
                        draft.id,
                        draft.updated,
                        draft.state.name,
                        draftJson(draft).toString(),
                    ),
                )
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            assertEquals(1, store.contacts().size)
        }
        val repo = MailRepository(context, accounts)
        assertEquals(listOf(account), repo.initialize())
        val db = repo.store(account)
        val contacts = db.contacts().associateBy { it.email }
        assertEquals("陈乐媛", contacts.getValue("chen@example.test").name)
        assertEquals("已发送联系人", contacts.getValue("sent@example.test").name)
        assertEquals("抄送同事", contacts.getValue("cc@example.test").name)
        assertEquals("密送同事", contacts.getValue("bcc@example.test").name)
        assertEquals("手动姓名", contacts.getValue("manual@example.test").name)
        assertEquals(601, db.messages("INBOX").size)
        assertEquals("原始正文不能改写", db.messages("INBOX").last().body)
        assertEquals(draft, db.draft(draft.id))
        db.close()
        MailStore(context, account.id).use {
            assertEquals(contacts.values.toSet(), it.contacts().toSet())
        }
    }

    @Test
    fun chineseNamesOutrankAliasesAndOlderRefreshesCannotUndoNewNames() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            store.initializeContacts()
            store.rememberContacts("alias <PERSON@example.test>", 100)
            store.rememberContacts("张三 <person@example.test>", 20)
            store.rememberContacts("person@example.test", 200)
            store.rememberContacts("Another Alias <person@example.test>", 300)
            assertEquals("张三", store.contacts().single().name)
            store.rememberContacts("张老师 <person@example.test>", 50)
            store.rememberContacts("张三 <person@example.test>", 40)
            assertEquals("张老师", store.contacts().single().name)
            assertEquals(1, store.contacts().size)
        }
    }

    @Test
    fun manualEditsAndIntentionallyClearedNamesAlwaysWinAfterReopen() {
        val id = UUID.randomUUID().toString()
        MailStore(context, id).use { store ->
            store.rememberContacts("自动名称 <person@example.test>", 10)
            store.saveContact(MailContact("PERSON@example.test", "我的备注名"))
        }
        MailStore(context, id).use { store ->
            store.initializeContacts()
            store.put(mail().copy(recipients = "更新后的名字 <person@example.test>"))
            assertEquals(
                "我的备注名",
                store.contacts().single { it.email == "person@example.test" }.name,
            )
            store.saveContact(MailContact("person@example.test", ""))
            store.rememberContacts("不应恢复 <person@example.test>", 10000)
            assertEquals("", store.contacts().single { it.email == "person@example.test" }.name)
        }
    }

    @Test
    fun versionThreeMigrationKeepsUsefulNamesAndEnrichesPlaceholderNames() {
        val id = UUID.randomUUID().toString()
        val path = context.getDatabasePath("mail-$id.db")
        path.parentFile!!.mkdirs()
        val original =
            mail().copy(recipients = "张三 <person@example.test>, 邮件名称 <manual@example.test>")
        val draft = Draft(body = "旧草稿")
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL(
                "CREATE TABLE contacts (email TEXT PRIMARY KEY COLLATE NOCASE,name TEXT NOT NULL,updated INTEGER NOT NULL)"
            )
            db.execSQL(
                "CREATE TABLE messages (key TEXT PRIMARY KEY,folder TEXT NOT NULL,date INTEGER NOT NULL,payload TEXT NOT NULL)"
            )
            db.execSQL(
                "CREATE TABLE drafts (id TEXT PRIMARY KEY,updated INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL)"
            )
            db.execSQL(
                "CREATE TABLE arrival_cursor (folder TEXT PRIMARY KEY,validity INTEGER NOT NULL,uid INTEGER NOT NULL)"
            )
            db.execSQL("CREATE TABLE arrival_pending (key TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            db.execSQL("INSERT INTO contacts VALUES('person@example.test','person',1)")
            db.execSQL("INSERT INTO contacts VALUES('manual@example.test','保留旧备注',2)")
            insertRaw(db, original)
            db.execSQL(
                "INSERT INTO drafts VALUES(?,?,?,?)",
                arrayOf<Any>(draft.id, draft.updated, draft.state.name, draftJson(draft).toString()),
            )
            db.execSQL("INSERT INTO arrival_cursor VALUES('INBOX',1,7)")
            db.version = 3
        }
        MailStore(context, id).use { store ->
            store.initializeContacts()
            assertEquals(4, store.readableDatabase.version)
            assertEquals("张三", store.contacts().single { it.email == "person@example.test" }.name)
            assertEquals(
                "保留旧备注",
                store.contacts().single { it.email == "manual@example.test" }.name,
            )
            assertEquals(original, store.messages("INBOX").single())
            assertEquals(draft, store.draft(draft.id))
            assertEquals(
                7L,
                DatabaseUtils.longForQuery(
                    store.readableDatabase,
                    "SELECT uid FROM arrival_cursor",
                    null,
                ),
            )
        }
    }

    @Test
    fun initializationRunsOnceAndRepeatedSyncDoesNotRewriteUnchangedContacts() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            val item = mail().copy(recipients = "张三 <person@example.test>")
            store.put(item)
            store.initializeContacts()
            val db = store.writableDatabase
            db.execSQL("CREATE TABLE updates(n INTEGER)")
            db.execSQL("INSERT INTO updates VALUES(0)")
            db.execSQL(
                "CREATE TRIGGER count_contact_updates AFTER UPDATE ON contacts BEGIN UPDATE updates SET n=n+1; END"
            )
            store.initializeContacts()
            store.put(item)
            assertEquals(0L, DatabaseUtils.longForQuery(db, "SELECT n FROM updates", null))
            // An invalid payload added outside the mail API proves subsequent initialization does
            // not scan payloads again. Normal sync always learns contacts when it stores a message.
            db.execSQL("INSERT INTO messages VALUES('invalid','INBOX',900,'invalid-json')")
            store.initializeContacts()
            assertTrue(store.contacts().any { it.name == "张三" })
        }
    }

    @Test
    fun failedInitializationRollsBackAndCanRetryWithoutLosingMail() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            val db = store.writableDatabase
            insertRaw(db, mail().copy(recipients = "张三 <person@example.test>"))
            db.execSQL("INSERT INTO messages VALUES('invalid','INBOX',900,'invalid-json')")
            assertTrue(runCatching { store.initializeContacts() }.isFailure)
            assertTrue(store.contacts().isEmpty())
            assertEquals(0L, DatabaseUtils.queryNumEntries(db, "contact_learning"))
            assertEquals(2L, DatabaseUtils.queryNumEntries(db, "messages"))
            db.delete("messages", "key=?", arrayOf("invalid"))
            store.initializeContacts()
            assertTrue(store.contacts().any { it.name == "张三" })
        }
    }

    @Test
    fun newMailDraftsAndSendSubmissionLearnContactsIncrementallyAndRemainAccountLocal() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            store.initializeContacts()
            store.replaceWindow(
                "INBOX",
                1,
                listOf(mail().copy(recipients = "初始同事 <first@example.test>")),
            )
            store.replaceWindow("INBOX", 1, listOf(mail(2).copy(cc = "新同事 <new@example.test>")))
            store.beginSend(
                Draft(to = "发送同事 <sent@example.test>", bcc = "密送同事 <hidden@example.test>")
            )
            store.save(Draft(cc = "草稿同事 <draft@example.test>"))
            val contacts = store.contacts().associateBy { it.email }
            assertEquals("初始同事", contacts.getValue("first@example.test").name)
            assertEquals("新同事", contacts.getValue("new@example.test").name)
            assertEquals("发送同事", contacts.getValue("sent@example.test").name)
            assertEquals("密送同事", contacts.getValue("hidden@example.test").name)
            assertEquals("草稿同事", contacts.getValue("draft@example.test").name)
        }
        MailStore(context, UUID.randomUUID().toString()).use { assertTrue(it.contacts().isEmpty()) }
    }
}
