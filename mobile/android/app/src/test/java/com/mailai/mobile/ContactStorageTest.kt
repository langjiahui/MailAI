package com.mailai.mobile

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.icegreen.greenmail.util.GreenMail
import com.icegreen.greenmail.util.ServerSetup
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.net.InetAddress
import java.util.Properties
import java.util.UUID
import javax.mail.Session
import javax.mail.internet.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class ContactStorageTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun mail() =
        MailItem(
            "INBOX:1:1",
            "INBOX",
            1,
            1,
            "林安 <lin@example.test>",
            "lin@example.test",
            "user@example.test",
            "原邮件",
            1,
            false,
            "缓存正文",
            html = "<table><tr><td>原邮件</td></tr></table>",
            cc = "陈予 <chen@example.test>",
        )

    @Test
    fun contactsPersistBeyondSyncAndRemainAccountScoped() {
        val id = UUID.randomUUID().toString()
        MailStore(context, id).use {
            it.put(mail())
            it.rememberContacts("lin@example.test")
            assertEquals("林安", it.contacts().single { c -> c.email == "lin@example.test" }.name)
            it.replaceWindow("INBOX", 1, emptyList())
            assertEquals(3, it.contacts().size)
        }
        MailStore(context, id).use { assertEquals(3, it.contacts().size) }
        MailStore(context, UUID.randomUUID().toString()).use { assertTrue(it.contacts().isEmpty()) }
    }

    @Test
    fun fullContentSurvivesWindowRefreshAndOldJsonRemainsReadable() {
        MailStore(context, UUID.randomUUID().toString()).use {
            val original =
                mail()
                    .copy(
                        attachments =
                            listOf(
                                Attachment("1", "logo.png", "image/png", 32, "local-logo", "logo")
                            )
                    )
            it.put(original)
            it.replaceWindow(
                "INBOX",
                1,
                listOf(original.copy(body = null, html = null, attachments = emptyList())),
            )
            assertEquals(original, it.messages("INBOX").single())
            val old =
                mailJson(original).apply {
                    remove("html")
                    remove("cc")
                    remove("contentVersion")
                }
            assertEquals(0, mailFrom(old).contentVersion)
            assertEquals("缓存正文", mailFrom(old).body)
        }
    }

    @Test
    fun v2MigrationKeepsDraftAndMessageAndBackfillsContacts() {
        val id = UUID.randomUUID().toString()
        val name = "mail-$id.db"
        val message = mail()
        val draft = Draft(body = "不能丢失的旧草稿")
        MailStore(context, id).use {
            it.put(message)
            it.save(draft)
        }
        SQLiteDatabase.openDatabase(
                context.getDatabasePath(name).path,
                null,
                SQLiteDatabase.OPEN_READWRITE,
            )
            .use {
                it.execSQL("DROP TABLE contacts")
                it.execSQL("DROP TABLE contact_learning")
                it.version = 2
            }
        MailStore(context, id).use {
            assertEquals(4, it.readableDatabase.version)
            assertEquals(draft.body, it.draft(draft.id)?.body)
            assertEquals(message, it.messages("INBOX").single())
            it.initializeContacts()
            assertTrue(it.contacts().any { c -> c.email == "lin@example.test" })
        }
    }

    @Test
    fun rereadingLegacyMailKeepsDownloadedAttachmentsAndInlineImages() = runBlocking {
        TransportTest.tlsFixture()
        val server = GreenMail(ServerSetup(0, "127.0.0.1", "imaps"))
        server.start()
        val op = Operation()
        try {
            val user = server.setUser("reader@example.test", "reader@example.test", "test-only")
            val message =
                MimeMessage(Session.getInstance(Properties())).apply {
                    setFrom(InternetAddress("sender@example.test"))
                    setRecipients(javax.mail.Message.RecipientType.TO, "reader@example.test")
                    subject = "旧邮件原版升级"
                    setContent(
                        MimeMultipart("mixed").apply {
                            addBodyPart(
                                MimeBodyPart().apply {
                                    setContent(
                                        "<p>原版正文</p><img src='cid:brand'>",
                                        "text/html; charset=UTF-8",
                                    )
                                }
                            )
                            addBodyPart(
                                MimeBodyPart().apply {
                                    dataHandler =
                                        javax.activation.DataHandler(
                                            javax.mail.util.ByteArrayDataSource(
                                                byteArrayOf(1, 2, 3, 4),
                                                "image/png",
                                            )
                                        )
                                    setHeader("Content-ID", "<brand>")
                                    disposition = "inline"
                                    fileName = "brand.png"
                                    setHeader("Content-Type", "image/png")
                                }
                            )
                            addBodyPart(
                                MimeBodyPart().apply {
                                    setText("已下载附件内容", "UTF-8")
                                    disposition = "attachment"
                                    fileName = "document.txt"
                                }
                            )
                        }
                    )
                    saveChanges()
                }
            user.deliver(message)
            val a =
                Account(
                    email = "reader@example.test",
                    imap = Server("localhost", server.imaps.port),
                    smtp = Server("localhost", 465),
                )
            val cipher =
                object : SecretCipher {
                    override fun encrypt(text: String) = text

                    override fun decrypt(text: String) = text
                }
            val accounts = AccountStore(context, cipher).apply { put(a, "test-only") }
            val repo =
                MailRepository(
                    context,
                    accounts,
                    MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
                )
            repo.sync(a, "INBOX", 50, op)
            val original = repo.read(a, repo.store(a).messages("INBOX").single(), op)
            assertTrue(
                original.toString(),
                original.attachments.single { it.contentId == "brand" }.local.isNotBlank(),
            )
            val ordinary = original.attachments.single { it.name == "document.txt" }
            val downloaded = repo.download(a, original, ordinary, op) {}.first
            val legacy = downloaded.copy(html = null, contentVersion = 0)
            repo.store(a).put(legacy)
            val refreshed = repo.read(a, legacy, op, force = true)
            assertTrue(refreshed.html!!.contains("原版正文"))
            for (attachment in downloaded.attachments) {
                assertEquals(
                    attachment.local,
                    refreshed.attachments.single { it.part == attachment.part }.local,
                )
                assertTrue(repo.file(a, attachment.local).isFile)
            }
            assertEquals(
                "已下载附件内容",
                repo
                    .file(a, refreshed.attachments.single { it.name == "document.txt" }.local)
                    .readText(),
            )
            assertEquals(refreshed, repo.store(a).messages("INBOX").single())
            repo.store(a).close()
        } finally {
            op.release()
            server.stop()
        }
    }
}
