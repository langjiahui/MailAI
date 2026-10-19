package com.mailai.mobile

import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import org.junit.Assert.*
import org.junit.Test

class MailPresentationTest {
    private val mail =
        MailItem(
            "INBOX:1:1",
            "INBOX",
            1,
            1,
            "研发团队 <sender@example.test>",
            "Sender <SENDER@example.test>",
            "我 <me@example.test>, 同事 <c@example.test>",
            "项目方案",
            1,
            false,
            "请查看排期",
            listOf(Attachment("1", "方案.pdf", "application/pdf", 12)),
            cc = "C <C@example.test>, 其他 <other@example.test>",
        )

    @Test
    fun replyAllDeduplicatesAndExcludesOwnMailbox() {
        assertEquals(
            listOf("SENDER@example.test", "c@example.test", "other@example.test"),
            MailAddresses.parse(replyRecipients(mail, "ME@example.test", true)).map { it.email },
        )
        assertEquals(
            listOf("SENDER@example.test"),
            MailAddresses.parse(replyRecipients(mail, "me@example.test", false)).map { it.email },
        )
        assertEquals(
            "sender@example.test",
            MailAddresses.parse(replyRecipients(mail.copy(replyTo = ""), "me@example.test", false))
                .single()
                .email,
        )
    }

    @Test
    fun searchScopesMatchActualFieldsAndDecodeNames() {
        assertTrue(mail.matches("研发", SearchScope.SENDER))
        assertTrue(mail.matches("方案", SearchScope.SUBJECT))
        assertTrue(mail.matches("PDF", SearchScope.ATTACHMENTS))
        assertTrue(mail.matches("排期", SearchScope.ALL))
        assertFalse(mail.matches("排期", SearchScope.SUBJECT))
        assertFalse(mail.matches(" ", SearchScope.ALL))
        val hidden =
            mail.copy(
                attachments = listOf(Attachment("2", "logo.png", "image/png", 1, "cached", "cid"))
            )
        assertFalse(hidden.matches("logo", SearchScope.ATTACHMENTS))
    }

    @Test
    fun forwardQuoteRetainsOriginalBodyAndUnicodeNames() {
        val quote = quotedForward(mail)
        assertTrue(quote.contains(mail.body!!))
        assertTrue(quote.contains("研发团队") && quote.contains("sender@example.test"))
        assertTrue(quote.contains(mail.subject))
        assertFalse(quote.contains("=?UTF"))
    }

    @Test
    fun oversizedReplyAllDoesNotSilentlyDropRecipients() {
        try {
            replyRecipients(
                mail.copy(recipients = (1..51).joinToString { "p$it@example.test" }),
                "me@example.test",
                true,
            )
            fail("Must preserve the recipient limit")
        } catch (_: IllegalArgumentException) {}
    }
}
