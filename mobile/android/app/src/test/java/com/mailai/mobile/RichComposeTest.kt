package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.MimeCodec
import java.io.File
import java.util.Properties
import java.util.UUID
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.Session
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class RichComposeTest {
    @Test
    fun formattingAndOptionalRecipientsSurviveReopenAndLegacyDraftsStillLoad() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val account = UUID.randomUUID().toString()
        val draft =
            Draft(
                to = "to@example.test",
                cc = "cc@example.test",
                bcc = "hidden@example.test",
                body = "中文正文",
                styles = listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)),
            )
        MailStore(context, account).use { it.save(draft) }
        MailStore(context, account).use {
            val restored = it.draft(draft.id)!!
            assertEquals(draft.styles, restored.styles)
            assertEquals(draft.cc, restored.cc)
            assertEquals(draft.bcc, restored.bcc)
        }
        val legacy =
            draftJson(draft).apply {
                remove("styles")
                remove("cc")
                remove("bcc")
            }
        assertTrue(draftFrom(legacy).styles.isEmpty())
        assertEquals("", draftFrom(legacy).bcc)
    }

    @Test
    fun replacementsPasteAndDeletionKeepFormattingOffsets() {
        val style = listOf(BodyStyle(2, 6, BodyStyleKind.BOLD))
        assertEquals(
            listOf(BodyStyle(2, 8, BodyStyleKind.BOLD)),
            RichBody.edit("abcdefgh", "abcdXXefgh", style),
        )
        assertEquals(
            listOf(BodyStyle(1, 2, BodyStyleKind.BOLD)),
            RichBody.edit("abcdefgh", "afgh", style),
        )
        assertTrue(RichBody.edit("abcdefgh", "", style).isEmpty())
        val text = "😀中文正文"
        val ranges = listOf(BodyStyle(2, text.length, BodyStyleKind.ITALIC))
        assertEquals(
            listOf(BodyStyle(2, text.length + 1, BodyStyleKind.ITALIC)),
            RichBody.edit(text, "😀新内容正文", ranges),
        )
    }

    @Test
    fun togglingSelectionSplitsRangesAndMergesAdjacentStyles() {
        val all = listOf(BodyStyle(0, 6, BodyStyleKind.BOLD))
        assertEquals(
            listOf(BodyStyle(0, 2, BodyStyleKind.BOLD), BodyStyle(4, 6, BodyStyleKind.BOLD)),
            RichBody.apply("abcdef", all, 2, 4, BodyStyleKind.BOLD),
        )
        assertEquals(
            all,
            RichBody.apply(
                "abcdef",
                listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)),
                2,
                6,
                BodyStyleKind.BOLD,
            ),
        )
    }

    @Test
    fun generatedHtmlEscapesUserContentAndRejectsUnsafeStylesAndUrls() {
        val body = "<script> & \"中文\""
        val html = RichBody.html(body, listOf(BodyStyle(0, body.length, BodyStyleKind.BOLD)))!!
        assertFalse(html.contains("<script>"))
        assertTrue(html.contains("&lt;script&gt;"))
        assertTrue(html.contains("font-weight:bold"))
        listOf(
                "javascript:alert(1)",
                "file:///tmp/x",
                "https://user:pass@example.test/x",
                "http://example.test",
            )
            .forEach { assertFalse(RichBody.safeLink(it)) }
        assertNull(
            RichBody.html(
                body,
                listOf(BodyStyle(0, body.length, BodyStyleKind.COLOR, "red;display:none")),
            )
        )
        assertTrue(RichBody.safeLink("https://example.test/path?a=1&b=2"))
    }

    @Test
    fun outgoingPreservesPlainAlternativeRichTextAndAttachment() {
        val a =
            Account(
                email = "sender@example.test",
                imap = Server("example.test"),
                smtp = Server("example.test", 465),
            )
        val file =
            File.createTempFile("rich-compose", ".txt").apply { writeText("synthetic attachment") }
        try {
            val d =
                Draft(
                    to = "to@example.test",
                    cc = "cc@example.test",
                    bcc = "bcc@example.test",
                    body = "你好，团队",
                    styles = listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)),
                    attachments =
                        listOf(Attachment("", "附件.txt", "text/plain", file.length(), "fixture")),
                )
            val mime = MimeCodec.outgoing(Session.getInstance(Properties()), a, d) { file }
            assertEquals(
                "cc@example.test",
                mime.getRecipients(Message.RecipientType.CC).single().toString(),
            )
            val mixed = mime.content as Multipart
            assertEquals(2, mixed.count)
            val alternative = mixed.getBodyPart(0).content as Multipart
            assertTrue(alternative.getBodyPart(0).isMimeType("text/plain"))
            assertEquals(d.body, alternative.getBodyPart(0).content.toString())
            assertTrue(alternative.getBodyPart(1).isMimeType("text/html"))
            assertTrue(alternative.getBodyPart(1).content.toString().contains("font-weight:bold"))
        } finally {
            file.delete()
        }
    }

    @Test
    fun envelopeDeduplicatesAllFieldsAndRejectsInjectionAndTooManyPeople() {
        val d =
            Draft(
                to = "one@example.test",
                cc = "one@example.test, two@example.test",
                bcc = "two@example.test, three@example.test",
            )
        assertEquals(3, MimeCodec.recipients(d).sumOf { it.second.size })
        assertThrows(IllegalArgumentException::class.java) {
            MimeCodec.recipients(d.copy(bcc = "x@example.test\r\nSubject: injected"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            MimeCodec.recipients(d.copy(cc = (1..50).joinToString { "p$it@example.test" }))
        }
    }

    @Test
    fun localStarsSurviveReopenAndRefreshButNeverTransferToNewValidity() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val id = UUID.randomUUID().toString()
        val mail =
            MailItem(
                "INBOX:1:1",
                "INBOX",
                1,
                1,
                "sender@example.test",
                "sender@example.test",
                "me@example.test",
                "合成邮件",
                1,
                false,
                body = "正文",
            )
        MailStore(context, id).use {
            it.put(mail)
            it.setStarred("INBOX", mail.key, true)
        }
        MailStore(context, id).use {
            assertTrue(it.messages("INBOX").single().starred)
            // A concurrent body/read/attachment result was captured before the star change.
            it.put(mail.copy(unread = true, body = "已补读的正文"))
            assertTrue(it.messages("INBOX").single().starred)
            it.setStarred("INBOX", mail.key, false)
            it.put(mail.copy(starred = true))
            assertFalse(it.messages("INBOX").single().starred)
            it.setStarred("INBOX", mail.key, true)
            it.replaceWindow("INBOX", 1, listOf(mail))
            assertTrue(it.messages("INBOX").single().starred)
            it.replaceWindow("INBOX", 2, listOf(mail.copy(key = "INBOX:2:1", validity = 2)))
            assertFalse(it.messages("INBOX").single().starred)
        }
    }
}
