package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.icegreen.greenmail.util.GreenMail
import com.icegreen.greenmail.util.ServerSetup
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.io.File
import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class NetworkRecoveryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val cipher =
        object : SecretCipher {
            override fun encrypt(text: String) = text.reversed()

            override fun decrypt(text: String) = text.reversed()
        }

    @Test
    fun interruptedSyncAndAttachmentKeepCacheAndRecoverWithoutDuplicateRows() = runBlocking {
        TransportTest.tlsFixture()
        val server =
            GreenMail(
                arrayOf(ServerSetup(0, "127.0.0.1", "imap"), ServerSetup(0, "127.0.0.1", "smtps"))
            )
        server.start()
        val email = "fixture@example.test"
        server.setUser(email, email, "fixture")
        val relay = FaultImapRelay(server.imap.port)
        val a =
            Account(
                email = email,
                imap = Server("localhost", relay.port),
                smtp = Server("localhost", server.smtps.port),
            )
        val accounts = AccountStore(context, cipher).apply { put(a, "fixture") }
        val transport = MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted)
        val repo = MailRepository(context, accounts, transport)
        val payload = ByteArray(200_000) { (it % 251).toByte() }
        val file = File.createTempFile("mailai-network-", ".bin").apply { writeBytes(payload) }
        fun deliver(subject: String) {
            val op = Operation()
            try {
                transport.send(
                    a,
                    "fixture",
                    Draft(
                        to = email,
                        subject = subject,
                        body = "本地缓存正文",
                        attachments =
                            listOf(
                                Attachment(
                                    "",
                                    "合成附件.bin",
                                    "application/octet-stream",
                                    payload.size.toLong(),
                                    "fixture",
                                )
                            ),
                    ),
                    { file },
                    op,
                ) {}
            } finally {
                op.release()
            }
        }
        suspend fun <T> operation(block: suspend (Operation) -> T): T {
            val op = Operation()
            return try {
                block(op)
            } finally {
                op.release()
            }
        }
        try {
            deliver("第一封")
            assertTrue(server.waitForIncomingEmail(5000, 1))
            operation { repo.sync(a, "INBOX", 50, it) }
            val original = operation { repo.read(a, repo.store(a).messages("INBOX").single(), it) }
            val draft = Draft(body = "断网前已经保存的草稿")
            repo.store(a).save(draft)
            deliver("第二封")
            assertTrue(server.waitForIncomingEmail(5000, 2))
            relay.interruptResponseTo("FETCH")
            try {
                operation { repo.sync(a, "INBOX", 50, it) }
                fail("partial sync must fail")
            } catch (_: javax.mail.MessagingException) {}
            assertEquals(1, relay.interruptions.get())
            assertEquals(original, repo.store(a).messages("INBOX").single())
            assertEquals(draft.body, repo.store(a).draft(draft.id)?.body)
            operation { repo.sync(a, "INBOX", 50, it) }
            operation { repo.sync(a, "INBOX", 50, it) }
            val recovered = repo.store(a).messages("INBOX")
            assertEquals(2, recovered.size)
            assertEquals(2, recovered.map { it.key }.toSet().size)
            assertEquals(original.body, recovered.single { it.key == original.key }.body)
            relay.interruptResponseTo("BODY.PEEK[", 512)
            try {
                operation { repo.download(a, original, original.attachments.single(), it) {} }
                fail("partial attachment must fail")
            } catch (_: Exception) {}
            assertEquals(2, relay.interruptions.get())
            assertTrue(repo.accountDir(a).listFiles().orEmpty().none { it.name.endsWith(".part") })
            assertEquals(
                "",
                repo
                    .store(a)
                    .messages("INBOX")
                    .single { it.key == original.key }
                    .attachments
                    .single()
                    .local,
            )
            val (_, downloaded) =
                operation { repo.download(a, original, original.attachments.single(), it) {} }
            assertArrayEquals(payload, repo.file(a, downloaded.local).readBytes())
        } finally {
            relay.close()
            server.stop()
            file.delete()
        }
    }
}
