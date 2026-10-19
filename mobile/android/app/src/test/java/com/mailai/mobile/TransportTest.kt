package com.mailai.mobile

import com.icegreen.greenmail.util.GreenMail
import com.icegreen.greenmail.util.ServerSetup
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.io.File
import java.net.InetAddress
import java.security.KeyStore
import javax.net.ssl.*
import org.junit.*
import org.junit.Assert.*

class TransportTest {
    companion object {
        lateinit var keys: File
        lateinit var trusted: SSLSocketFactory

        @BeforeClass
        @JvmStatic
        fun tlsFixture() {
            keys = File("build/tmp/test-mail/localhost.p12").absoluteFile
            keys.parentFile!!.mkdirs()
            if (!keys.exists()) {
                val tool = File(System.getProperty("java.home"), "bin/keytool").absolutePath
                val p =
                    ProcessBuilder(
                            tool,
                            "-genkeypair",
                            "-alias",
                            "test-only",
                            "-keyalg",
                            "RSA",
                            "-keystore",
                            keys.path,
                            "-storetype",
                            "PKCS12",
                            "-storepass",
                            "test-only",
                            "-keypass",
                            "test-only",
                            "-dname",
                            "CN=localhost",
                            "-ext",
                            "SAN=dns:localhost",
                            "-validity",
                            "3650",
                            "-noprompt",
                        )
                        .redirectErrorStream(true)
                        .start()
                val output = p.inputStream.bufferedReader().readText()
                check(p.waitFor() == 0) { output }
            }
            System.setProperty("greenmail.tls.keystore.file", keys.path)
            System.setProperty("greenmail.tls.keystore.password", "test-only")
            val ks =
                KeyStore.getInstance("PKCS12").apply {
                    keys.inputStream().use { load(it, "test-only".toCharArray()) }
                }
            val trust =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                    init(ks)
                }
            trusted =
                SSLContext.getInstance("TLS")
                    .apply { init(null, trust.trustManagers, null) }
                    .socketFactory
        }
    }

    lateinit var server: GreenMail

    @Before
    fun start() {
        server =
            GreenMail(
                arrayOf(ServerSetup(0, "127.0.0.1", "imaps"), ServerSetup(0, "127.0.0.1", "smtps"))
            )
        server.start()
        server.setUser("sender@example.test", "sender@example.test", "test-password")
        server.setUser("receiver@example.test", "receiver@example.test", "test-password")
    }

    @After
    fun stop() {
        server.stop()
    }

    private fun account(email: String = "sender@example.test", host: String = "localhost") =
        Account(
            email = email,
            imap = Server(host, server.imaps.port),
            smtp = Server(host, server.smtps.port),
        )

    private fun transport() = MailTransport({ InetAddress.getByName("127.0.0.1") }, trusted)

    @Test
    fun loginFailureIdentifiesReceivingStageWithoutExposingSecret() {
        val op = Operation()
        try {
            val error =
                assertThrows(MailLoginFailure::class.java) {
                    transport().verify(account(), "synthetic-wrong-password", op) {}
                }
            assertEquals("收信", error.stage)
            assertEquals("localhost", error.host)
            assertFalse(error.message.orEmpty().contains("synthetic-wrong-password"))
        } finally {
            op.release()
        }
    }

    @Test
    fun loginFailureIdentifiesSmtpAfterImapSucceeded() {
        val outgoing = GreenMail(ServerSetup(0, "127.0.0.1", "smtps"))
        outgoing.start()
        outgoing.setUser("sender@example.test", "sender@example.test", "different-password")
        val op = Operation()
        try {
            val error =
                assertThrows(MailLoginFailure::class.java) {
                    transport().verify(
                        account().copy(smtp = Server("localhost", outgoing.smtps.port)),
                        "test-password",
                        op,
                    ) {}
                }
            assertEquals("发信", error.stage)
            assertEquals("localhost", error.host)
        } finally {
            op.release()
            outgoing.stop()
        }
    }

    @Test
    fun encryptedChineseMailAndAttachmentRoundTrip() {
        val client = transport()
        val a = account()
        val op = Operation()
        val file = File.createTempFile("mailai-fixture", ".txt").apply { writeText("合成附件内容") }
        try {
            client.verify(a, "test-password", op) {}
            var submissions = 0
            client.send(
                a,
                "test-password",
                Draft(
                    to = "receiver@example.test",
                    subject = "中文主题",
                    body = "中文正文",
                    attachments =
                        listOf(Attachment("", "合成附件.txt", "text/plain", file.length(), "fixture")),
                ),
                { file },
                op,
            ) {
                submissions++
            }
            assertEquals(1, submissions)
            assertTrue(server.waitForIncomingEmail(5000, 1))
            val receiver = account("receiver@example.test")
            val (_, list) = client.sync(receiver, "test-password", "INBOX", 50, op)
            assertEquals(1, list.size)
            assertEquals("中文主题", list.single().subject)
            assertTrue(list.single().unread)
            val loaded = client.read(receiver, "test-password", list.single(), op)
            assertTrue(loaded.body!!.contains("中文正文"))
            assertEquals(1, loaded.attachments.size)
            assertTrue(
                client.sync(receiver, "test-password", "INBOX", 50, op).second.single().unread
            )
            val downloaded = File.createTempFile("mailai-download", ".txt")
            try {
                client.download(
                    receiver,
                    "test-password",
                    loaded,
                    loaded.attachments.single(),
                    downloaded,
                    op,
                ) {}
                assertEquals("合成附件内容", downloaded.readText())
            } finally {
                downloaded.delete()
            }
            client.seen(receiver, "test-password", loaded, op)
            assertFalse(
                client.sync(receiver, "test-password", "INBOX", 50, op).second.single().unread
            )
            try {
                client.read(
                    receiver,
                    "test-password",
                    loaded.copy(validity = loaded.validity + 1),
                    op,
                )
                fail("stale UID must fail")
            } catch (_: IllegalStateException) {}
        } finally {
            op.release()
            file.delete()
        }
    }

    @Test
    fun startTlsIsRequiredForBothProtocols() {
        val plain =
            GreenMail(
                arrayOf(ServerSetup(0, "127.0.0.1", "imap"), ServerSetup(0, "127.0.0.1", "smtp"))
            )
        plain.start()
        plain.setUser("tls@example.test", "tls@example.test", "test-password")
        val imapBridge = StartTlsBridge(plain.imap.port, true)
        val smtpBridge = StartTlsBridge(plain.smtp.port, false)
        val a =
            Account(
                email = "tls@example.test",
                imap = Server("localhost", imapBridge.port, Security.STARTTLS),
                smtp = Server("localhost", smtpBridge.port, Security.STARTTLS),
            )
        val op = Operation()
        try {
            val client = transport()
            client.verify(a, "test-password", op) {}
            client.send(
                a,
                "test-password",
                Draft(to = a.email, body = "STARTTLS synthetic"),
                { error("no file") },
                op,
            ) {}
            assertTrue(plain.waitForIncomingEmail(5000, 1))
            assertEquals(1, client.sync(a, "test-password", "INBOX", 50, op).second.size)
            assertTrue(imapBridge.upgrades.get() >= 2)
            assertTrue(smtpBridge.upgrades.get() >= 2)
        } finally {
            op.release()
            imapBridge.close()
            smtpBridge.close()
            plain.stop()
        }
    }

    @Test
    fun rejectsUntrustedCertificate() {
        val op = Operation()
        try {
            MailTransport({ InetAddress.getByName("127.0.0.1") }).verify(
                account(),
                "test-password",
                op,
            ) {}
            fail("must reject certificate")
        } catch (_: javax.mail.MessagingException) {} finally {
            op.release()
        }
    }

    @Test
    fun rejectsWrongHostnameEvenWithTrustedCertificate() {
        val op = Operation()
        try {
            transport().verify(account(host = "wrong.example.test"), "test-password", op) {}
            fail("must reject hostname")
        } catch (_: javax.mail.MessagingException) {} finally {
            op.release()
        }
    }

    @Test
    fun authenticationFailureDoesNotSubmit() {
        val op = Operation()
        var submitted = false
        try {
            transport().send(
                account(),
                "wrong",
                Draft(to = "receiver@example.test", body = "synthetic"),
                { error("no files") },
                op,
            ) {
                submitted = true
            }
            fail("must reject auth")
        } catch (_: javax.mail.MessagingException) {} finally {
            op.release()
        }
        assertFalse(submitted)
        assertEquals(0, server.receivedMessages.size)
    }
}
