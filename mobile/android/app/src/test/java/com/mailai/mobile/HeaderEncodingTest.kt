package com.mailai.mobile

import com.mailai.mobile.mail.*
import java.nio.charset.Charset
import java.util.Base64
import java.util.Properties
import javax.mail.Session
import javax.mail.internet.MimeMessage
import org.junit.Assert.*
import org.junit.Test

class HeaderEncodingTest {
    private fun word(name: String, actual: String, declared: String, q: Boolean = false): String {
        val bytes = name.toByteArray(Charset.forName(actual))
        val payload =
            if (q) bytes.joinToString("") { "=%02X".format(it.toInt() and 255) }
            else Base64.getEncoder().encodeToString(bytes)
        return "=?$declared?${if (q) "Q" else "B"}?$payload?="
    }

    @Test
    fun legacyDeclarationsUnknownLabelsAndValidOtherLanguagesDecodeWithoutLoss() {
        val cases =
            listOf(
                Triple("测试镕", "GBK", "gb2312"),
                Triple("测试镕", "GBK", "UTF-8"),
                Triple("扩展𠮷", "GB18030", "GBK"),
                Triple("测试姓名", "UTF-8", "unknown-charset"),
                Triple("測試姓名", "Big5", "Big5"),
                Triple("François", "ISO-8859-1", "ISO-8859-1"),
                Triple("Привет", "KOI8-R", "KOI8-R"),
                Triple("山田太郎", "ISO-2022-JP", "ISO-2022-JP"),
            )
        for ((name, actual, declared) in cases) for (q in listOf(false, true)) {
            val encoded = word(name, actual, declared, q)
            assertEquals(name, MailHeaderCodec.decode(encoded))
            assertEquals(
                MailContact("person@example.test", name),
                MailAddresses.parse("$encoded <person@example.test>").single(),
            )
            assertEquals(name, MimeCodec.fileName(encoded))
        }
    }

    @Test
    fun incorrectlyDeclaredTextBodiesUseTheSameStrictFallback() {
        val text = "测试镕：正文仍可正常阅读"
        val payload = Base64.getEncoder().encodeToString(text.toByteArray(Charset.forName("GBK")))
        for (label in listOf("gb2312", "utf-8", "unknown-charset")) {
            val raw =
                "Content-Type: text/plain; charset=$label\r\nContent-Transfer-Encoding: base64\r\n\r\n$payload"
            val message =
                MimeMessage(
                    Session.getInstance(Properties()),
                    raw.byteInputStream(Charsets.US_ASCII),
                )
            assertEquals(text, MimeCodec.content(message).text)
        }
    }

    @Test
    fun encodedPunctuationNeverChangesDeliveryRecipientsOrNameRoundTrips() {
        for (name in listOf("测试镕, 项目;采购", "张三:项目(采购)", "张三\"采购\"", "张三\\采购")) {
            val raw = "${word(name, "GBK", "UTF-8")} <person@example.test>, other@example.test"
            val contacts = MailAddresses.parse(raw)
            assertEquals(
                listOf("person@example.test", "other@example.test"),
                contacts.map { it.email },
            )
            assertEquals(name, contacts.first().name)
            val displayed = MailAddresses.display(raw)
            assertEquals(contacts, MailAddresses.parse(displayed))
            assertEquals(
                contacts.map { it.email },
                MimeCodec.addresses(displayed).map { it.address },
            )
        }
    }

    @Test
    fun mixedUnicodeFoldingAndBrokenWordsStayReadable() {
        val encoded = word("测试镕", "GBK", "UTF-8")
        assertEquals("中文 测试镕", MailHeaderCodec.decode("中文 $encoded"))
        assertEquals("测试镕 原文", MailHeaderCodec.decode("$encoded 原文"))
        assertEquals("测试镕测试镕", MailHeaderCodec.decode("$encoded\r\n\t$encoded"))
        assertEquals("Plain folded", MailHeaderCodec.decode("Plain\r\n folded"))
        assertEquals("=?broken", MailHeaderCodec.decode("=?broken"))
        assertEquals("=?utf-8?B?!!!!?=", MailHeaderCodec.decode("=?utf-8?B?!!!!?="))
        assertFalse(MailHeaderCodec.damaged("扩展𠮷 / Привет / العربية"))
        assertTrue(MailHeaderCodec.damaged("测试�F"))
        assertTrue(MailHeaderCodec.damaged("孤立\udc80"))
    }
}
