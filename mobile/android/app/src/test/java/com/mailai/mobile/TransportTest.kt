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
    fun mislabeledHeadersRemainReadableAcrossImapSyncAndBodyRead() {
        val user = server.setUser("encoding@example.test", "encoding@example.test", "test-password")
        val name = "测试镕, 项目"
        val payload =
            java.util.Base64.getEncoder()
                .encodeToString(name.toByteArray(java.nio.charset.Charset.forName("GBK")))
        val word = "=?UTF-8?B?$payload?="
        val raw =
            "From: $word <sender@example.test>\r\nTo: $word <encoding@example.test>\r\nCc: $word <cc@example.test>\r\nSubject: $word\r\nContent-Type: text/plain; charset=gb2312\r\nContent-Transfer-Encoding: base64\r\n\r\n$payload"
        user.deliver(
            javax.mail.internet.MimeMessage(
                javax.mail.Session.getInstance(java.util.Properties()),
                raw.byteInputStream(Charsets.US_ASCII),
            )
        )
        val a = account("encoding@example.test")
        val op = Operation()
        try {
            val item = transport().sync(a, "test-password", "INBOX", 50, op).second.single()
            assertEquals(name, item.subject)
            assertEquals(name, MailAddresses.sender(item.sender).name)
            assertEquals(name, MailAddresses.parse(item.recipients).single().name)
            assertEquals(name, MailAddresses.parse(item.cc).single().name)
            assertTrue(item.unread)
            assertEquals(name, transport().read(a, "test-password", item, op).body)
        } finally {
            op.release()
        }
    }

    @Test
    fun rejectedServerSearchNeverFallsBackToDownloadingMailboxBodies() {
        val plain = GreenMail(ServerSetup(0, "127.0.0.1", "imap"))
        plain.start()
        val relay = FaultImapRelay(plain.imap.port, true)
        val op = Operation()
        try {
            val user = plain.setUser("search@example.test", "search@example.test", "test-password")
            user.deliver(
                javax.mail.internet
                    .MimeMessage(javax.mail.Session.getInstance(java.util.Properties()))
                    .apply {
                        setFrom("sender@example.test")
                        setRecipients(javax.mail.Message.RecipientType.TO, "search@example.test")
                        subject = "Cached"
                        setText("server body must not be downloaded")
                        saveChanges()
                    }
            )
            val a = account("search@example.test").copy(imap = Server("localhost", relay.port))
            assertThrows(javax.mail.MessagingException::class.java) {
                transport().search(a, "test-password", "INBOX", "Cached", 50, op)
            }
            assertEquals(0, relay.fetches.get())
        } finally {
            op.release()
            relay.close()
            plain.stop()
        }
    }

    @Test
    fun serverSearchFindsOlderChineseBodyAndPaginatesWithoutMarkingRead() {
        val user = server.setUser("search@example.test", "search@example.test", "test-password")
        for (i in 1..64) {
            val message =
                javax.mail.internet
                    .MimeMessage(javax.mail.Session.getInstance(java.util.Properties()))
                    .apply {
                        setFrom(
                            javax.mail.internet.InternetAddress(
                                "sender@example.test",
                                "方君",
                                "UTF-8",
                            )
                        )
                        setRecipients(javax.mail.Message.RecipientType.TO, "search@example.test")
                        setSubject("检索分页 $i", "UTF-8")
                        setText(if (i == 1) "只在最早邮件中的特定正文" else "普通正文", "UTF-8")
                        saveChanges()
                    }
            user.deliver(message)
        }
        val a = account("search@example.test")
        val op = Operation()
        try {
            val latest = transport().sync(a, "test-password", "INBOX", 50, op).second
            assertFalse(latest.any { it.subject == "检索分页 1" })
            val older = transport().search(a, "test-password", "INBOX", "特定正文", 50, op)
            assertEquals(1, older.total)
            assertEquals("检索分页 1", older.messages.single().subject)
            val first = transport().search(a, "test-password", "INBOX", "检索分页", 50, op)
            val more = transport().search(a, "test-password", "INBOX", "检索分页", 100, op)
            assertEquals(64, first.total)
            assertEquals(50, first.messages.size)
            assertEquals(64, more.messages.size)
            assertEquals(64, more.messages.map { it.key }.distinct().size)
            assertTrue(more.messages.all { it.unread })
            assertThrows(IllegalArgumentException::class.java) {
                transport().search(a, "test-password", "INBOX", "x\r\nBAD", 50, op)
            }
        } finally {
            op.release()
        }
    }

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
    fun formattedMailReachesCcAndBccWithoutExposingBccOnTheWire() {
        server.setUser("cc@example.test", "cc@example.test", "test-password")
        server.setUser("hidden@example.test", "hidden@example.test", "test-password")
        val op = Operation()
        try {
            val draft =
                Draft(
                    to = "receiver@example.test",
                    cc = "cc@example.test",
                    bcc = "hidden@example.test",
                    body = "中文格式正文",
                    styles = listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)),
                )
            var submissions = 0
            transport().send(account(), "test-password", draft, { error("No files") }, op) {
                submissions++
            }
            assertTrue(server.waitForIncomingEmail(5000, 3))
            assertEquals(1, submissions)
            assertEquals(3, server.receivedMessages.size)
            server.receivedMessages.forEach { mail ->
                assertNull(mail.getHeader("Bcc"))
                val content = MimeCodec.content(mail)
                assertEquals(draft.body, content.text.trim())
                assertTrue(content.html!!.contains("font-weight:bold"))
                assertEquals(draft.messageId, mail.messageID)
            }
        } finally {
            op.release()
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
            val loaded =
                client.read(receiver, "test-password", list.single().copy(starred = true), op)
            assertTrue(loaded.starred)
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
