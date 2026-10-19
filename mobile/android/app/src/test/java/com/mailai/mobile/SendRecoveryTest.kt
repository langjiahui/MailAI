package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.net.InetAddress
import java.net.ServerSocket
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.*
import kotlin.concurrent.thread
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Keep JVM protocol fixtures on JSSE; Android Conscrypt is exercised on the emulator.
@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class SendRecoveryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    // Test-only reversible cipher isolates state-machine behavior from Android Keystore.
    private val cipher =
        object : SecretCipher {
            override fun encrypt(text: String) = text.reversed()

            override fun decrypt(text: String) = text.reversed()
        }

    @Test
    fun lostSmtpAcknowledgementIsUncertainAndCannotResubmit() = runBlocking {
        TransportTest.tlsFixture()
        val ks =
            KeyStore.getInstance("PKCS12").apply {
                TransportTest.keys.inputStream().use { load(it, "test-only".toCharArray()) }
            }
        val km =
            KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(ks, "test-only".toCharArray())
            }
        val ssl = SSLContext.getInstance("TLS").apply { init(km.keyManagers, null, null) }
        val server =
            ssl.serverSocketFactory.createServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        val count = AtomicInteger()
        val worker =
            thread(isDaemon = true) {
                server.accept().use { socket ->
                    socket.soTimeout = 10000
                    val input = socket.getInputStream().bufferedReader()
                    val out = socket.getOutputStream().bufferedWriter()
                    fun reply(s: String) {
                        out.write(s + "\r\n")
                        out.flush()
                    }
                    reply("220 localhost test")
                    while (true) {
                        val line = input.readLine() ?: break
                        when {
                            line.startsWith("EHLO") ->
                                reply("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 40000000")
                            line.startsWith("AUTH") -> reply("235 authenticated")
                            line.startsWith("MAIL") || line.startsWith("RCPT") ->
                                reply("250 accepted")
                            line == "DATA" -> {
                                reply("354 send data")
                                while (input.readLine()?.let { it != "." } == true) {}
                                count.incrementAndGet()
                                break
                            }
                            line == "QUIT" -> {
                                reply("221 bye")
                                break
                            }
                            else -> reply("250 ok")
                        }
                    }
                    // Simulate server accepting DATA but dropping the final acknowledgement.
                }
            }
        try {
            val a =
                Account(
                    email = "test-${java.util.UUID.randomUUID()}@example.test",
                    imap = Server("localhost", 993),
                    smtp = Server("localhost", server.localPort),
                )
            val accounts = AccountStore(context, cipher)
            accounts.put(a, "fixture")
            val repo =
                MailRepository(
                    context,
                    accounts,
                    MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
                )
            val d = Draft(to = "receiver@example.test", body = "synthetic only")
            val result = repo.send(a, d, Operation()) {}
            assertEquals(SendState.UNCERTAIN, result)
            assertEquals(1, count.get())
            assertEquals(SendState.UNCERTAIN, repo.store(a).draft(d.id)?.state)
            try {
                repo.send(a, d, Operation()) {}
                fail("must not resend uncertain mail")
            } catch (_: IllegalStateException) {}
            assertEquals(1, count.get())
            val reopened = MailRepository(context, accounts)
            assertEquals(SendState.UNCERTAIN, reopened.store(a).draft(d.id)?.state)
            try {
                reopened.send(a, d, Operation()) {}
                fail("reopen must not unlock uncertain mail")
            } catch (_: IllegalStateException) {}
            assertEquals(1, count.get())
        } finally {
            server.close()
            worker.join(2000)
        }
    }

    @Test
    fun connectionFailureKeepsEditableDraft() = runBlocking {
        TransportTest.tlsFixture()
        val port = ServerSocket(0).use { it.localPort }
        val a =
            Account(
                email = "test-${java.util.UUID.randomUUID()}@example.test",
                imap = Server("localhost", 993),
                smtp = Server("localhost", port),
            )
        val accounts = AccountStore(context, cipher)
        accounts.put(a, "fixture")
        val repo =
            MailRepository(
                context,
                accounts,
                MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
            )
        val d = Draft(to = "receiver@example.test", body = "preserved draft")
        try {
            repo.send(a, d, Operation()) {}
            fail("must fail connect")
        } catch (_: javax.mail.MessagingException) {}
        assertEquals(SendState.FAILED, repo.store(a).draft(d.id)?.state)
        assertEquals(d.body, repo.store(a).draft(d.id)?.body)
    }

    @Test
    fun delayedAcknowledgementRejectsConcurrentAndStaleResubmission() = runBlocking {
        TransportTest.tlsFixture()
        FaultSmtpServer(holdAcknowledgement = true).use { server ->
            val a =
                Account(
                    email = "slow@example.test",
                    imap = Server("localhost"),
                    smtp = Server("localhost", server.port),
                )
            val accounts = AccountStore(context, cipher).apply { put(a, "fixture") }
            val repo =
                MailRepository(
                    context,
                    accounts,
                    MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
                )
            val d = Draft(to = "receiver@example.test", body = "唯一发送的内容")
            val sending =
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).async {
                    val op = Operation()
                    try {
                        repo.send(a, d, op) {}
                    } finally {
                        op.release()
                    }
                }
            try {
                assertTrue(server.received.await(5, java.util.concurrent.TimeUnit.SECONDS))
                assertEquals(SendState.TRANSMITTING, repo.store(a).draft(d.id)?.state)
                try {
                    repo.send(a, d, Operation()) {}
                    fail("double send must be blocked")
                } catch (_: IllegalStateException) {}
                MailStore(context, a.id).use { secondConnection ->
                    try {
                        secondConnection.beginSend(d.copy(body = "不能覆盖的旧快照"))
                        fail("must not replace reserved content")
                    } catch (_: IllegalStateException) {}
                    try {
                        secondConnection.save(d)
                        fail("stale autosave must not unlock sending")
                    } catch (_: IllegalStateException) {}
                }
                assertEquals(1, server.connections.get())
                server.acknowledge.countDown()
                assertEquals(SendState.SENT, sending.await())
                val restored = MailRepository(context, accounts)
                assertEquals(SendState.SENT, restored.store(a).draft(d.id)?.state)
                assertEquals(d.body, restored.store(a).draft(d.id)?.body)
                try {
                    restored.send(a, d, Operation()) {}
                    fail("sent record must not resubmit")
                } catch (_: IllegalStateException) {}
                assertEquals(1, server.deliveries.get())
            } finally {
                server.acknowledge.countDown()
                sending.cancel()
            }
        }
    }

    @Test
    fun preSubmissionDisconnectPreservesDraftAndOnlyExplicitRetrySends() = runBlocking {
        TransportTest.tlsFixture()
        FaultSmtpServer(rejectFirstConnection = true).use { server ->
            val a =
                Account(
                    email = "retry@example.test",
                    imap = Server("localhost"),
                    smtp = Server("localhost", server.port),
                )
            val accounts = AccountStore(context, cipher).apply { put(a, "fixture") }
            val repo =
                MailRepository(
                    context,
                    accounts,
                    MailTransport({ InetAddress.getByName("127.0.0.1") }, TransportTest.trusted),
                )
            val d = Draft(to = "receiver@example.test", body = "断网时保留的正文")
            val first = Operation()
            try {
                repo.send(a, d, first) {}
                fail("first connection should drop")
            } catch (_: javax.mail.MessagingException) {} finally {
                first.release()
            }
            assertEquals(SendState.FAILED, repo.store(a).draft(d.id)?.state)
            assertEquals(d.body, repo.store(a).draft(d.id)?.body)
            assertEquals(0, server.deliveries.get())
            assertEquals(1, server.connections.get())
            val retry = Operation()
            try {
                assertEquals(SendState.SENT, repo.send(a, d, retry) {})
            } finally {
                retry.release()
            }
            assertEquals(1, server.deliveries.get())
            assertEquals(2, server.connections.get())
        }
    }
}
