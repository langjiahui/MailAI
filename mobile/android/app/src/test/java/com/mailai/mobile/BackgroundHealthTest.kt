package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.icegreen.greenmail.util.GreenMail
import com.icegreen.greenmail.util.ServerSetup
import com.mailai.mobile.background.*
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.UUID
import javax.mail.AuthenticationFailedException
import javax.mail.internet.MimeMessage
import javax.net.ssl.SSLHandshakeException
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class BackgroundHealthTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val cipher =
        object : SecretCipher {
            override fun encrypt(text: String) = text.reversed()

            override fun decrypt(text: String) = text.reversed()
        }

    @Test
    fun backgroundRecordsDoNotConfuseForegroundSuccessWithBackgroundSuccess() {
        val id = UUID.randomUUID().toString()
        val health = BackgroundHealth(context)
        AppPreferences(context).syncResult(id, true)
        assertEquals(0L, health.check(id).started)
        health.started(id)
        assertTrue(BackgroundHealth(context).check(id).interrupted)
        health.finished(id, "dns")
        assertFalse(BackgroundHealth(context).check(id).interrupted)
        assertEquals("dns", BackgroundHealth(context).check(id).failure)
        health.started(id)
        assertTrue(health.check(id).interrupted)
        health.finished(id)
        assertEquals("", health.check(id).failure)
    }

    @Test
    fun failureClassificationKeepsRawServerMessagesAndSecretsOutOfDiagnostics() {
        val errors =
            listOf(
                AuthenticationFailedException("synthetic-secret") to "login",
                SSLHandshakeException("synthetic-secret") to "tls",
                UnknownHostException("synthetic-secret") to "dns",
                IllegalStateException("synthetic-secret") to "connection",
            )
        errors.forEach { (error, code) ->
            assertEquals(code, BackgroundHealth.failure(RuntimeException(error)))
            assertFalse(BackgroundHealth.explanation(code).contains("synthetic-secret"))
        }
    }

    @Test
    fun overlappingWorkersSkipFreshNetworkChecksAndManualCheckCanForce() = runBlocking {
        TransportTest.tlsFixture()
        val server = GreenMail(ServerSetup(0, "127.0.0.1", "imap"))
        server.start()
        val user = server.setUser("fixture@example.test", "fixture@example.test", "fixture")
        user.deliver(
            MimeMessage(javax.mail.Session.getInstance(java.util.Properties())).apply {
                setFrom("sender@example.test")
                setRecipients(javax.mail.Message.RecipientType.TO, "fixture@example.test")
                subject = "background fixture"
                setText("body must not be fetched")
                saveChanges()
            }
        )
        val relay = FaultImapRelay(server.imap.port)
        val a =
            Account(
                email = "fixture@example.test",
                imap = Server("localhost", relay.port),
                smtp = Server("localhost", 465),
            )
        val accounts = AccountStore(context, cipher).apply { put(a, "fixture") }
        val repo =
            MailRepository(
                context,
                accounts,
                MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
            )
        val prefs = AppPreferences(context).apply { background = true }
        val draft = Draft(body = "preserved during sync")
        repo.store(a).save(draft)
        suspend fun check(force: Boolean = false) {
            val op = Operation()
            try {
                repo.syncBackground(a, op, force)
            } finally {
                op.release()
            }
        }
        try {
            coroutineScope { List(4) { async(Dispatchers.IO) { check() } }.awaitAll() }
            val fetches = relay.fetches.get()
            assertTrue(fetches > 0)
            assertEquals(1, relay.connections.get())
            assertEquals(1, repo.store(a).messages("INBOX").size)
            assertNull(repo.store(a).messages("INBOX").single().body)
            assertEquals(draft.body, repo.store(a).draft(draft.id)?.body)
            assertEquals("", BackgroundHealth(context).check(a.id).failure)
            check()
            assertEquals(fetches, relay.fetches.get())
            check(true)
            assertTrue(relay.fetches.get() > fetches)
            assertEquals(2, relay.connections.get())
            val beforeDisable = relay.fetches.get()
            prefs.background = false
            check(true)
            assertEquals(beforeDisable, relay.fetches.get())
        } finally {
            relay.close()
            server.stop()
        }
    }
}
