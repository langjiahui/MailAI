package com.mailai.mobile

import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.util.Properties
import javax.mail.Session
import javax.mail.internet.MimeMessage
import org.junit.Assert.*
import org.junit.Test

class CoreTest {
    @Test
    fun rejectsPrivateDestinations() {
        listOf(
                "127.0.0.1",
                "10.0.0.1",
                "172.16.1.1",
                "192.168.1.1",
                "169.254.169.254",
                "100.64.0.1",
                "0.0.0.0",
                "::1",
                "fc00::1",
                "fe80::1",
                "2002:7f00:1::1",
                "2001:0::1",
            )
            .forEach { assertFalse(it, NetworkPolicy.isPublic(InetAddress.getByName(it))) }
        assertTrue(NetworkPolicy.isPublic(InetAddress.getByName("8.8.8.8")))
    }

    @Test
    fun boundedCopyDoesNotPublishOversizedAttachment() {
        val out = ByteArrayOutputStream()
        try {
            MimeCodec.copyBounded(ByteArray(10).inputStream(), out, 8, Operation())
            fail("must reject")
        } catch (_: IllegalArgumentException) {
            assertEquals(0, out.size())
        }
    }

    @Test
    fun cancellationStopsCopy() {
        val op = Operation().apply { cancel() }
        try {
            MimeCodec.copyBounded(ByteArray(10).inputStream(), ByteArrayOutputStream(), 100, op)
            fail("must cancel")
        } catch (_: java.util.concurrent.CancellationException) {}
    }

    @Test
    fun maliciousHtmlBecomesInertText() {
        val m =
            MimeMessage(Session.getInstance(Properties())).apply {
                setContent(
                    "<h1>合同</h1><script>steal()</script><img src='http://127.0.0.1/secret'><p>请确认</p>",
                    "text/html; charset=UTF-8",
                )
                saveChanges()
            }
        val result = MimeCodec.read(m).first
        assertTrue(result.contains("合同"))
        assertTrue(result.contains("请确认"))
        assertFalse(result.contains("steal"))
        assertFalse(result.contains("127.0.0.1"))
    }

    @Test
    fun headerInjectionAndUnsafeFileName() {
        try {
            MimeCodec.addresses("a@example.test\r\nBcc: bad@example.test")
            fail("must reject")
        } catch (_: IllegalArgumentException) {}
        assertEquals(".._.._a_b.txt", MimeCodec.fileName("../../a\\b.txt"))
    }
}
