package com.mailai.mobile

import com.mailai.mobile.data.*
import com.mailai.mobile.mail.MailOutput
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test

class MailOutputTest {
    private val mail =
        MailItem(
            "INBOX:1:1",
            "INBOX",
            1,
            1,
            "发件人 <sender@example.test>",
            "",
            "to@example.test",
            "打印与分享",
            1,
            false,
            body = "完整正文\n历史引用",
            cc = "copy@example.test",
            attachments = listOf(Attachment("1", "report.txt", "text/plain", 12)),
        )

    @Test
    fun outputsFullContentAndNoActiveResources() {
        val output =
            MailOutput.document(
                mail.copy(
                    html =
                        """<script>alert(1)</script><style>body{display:none}</style><p onclick="evil()">完整正文</p><details><summary>历史引用</summary><p>完整引用</p></details><table><tr><td>123.45</td></tr></table><img src="cid:logo"><img src="https://remote.example.test/tracker"><iframe src="file:///private"></iframe><a href="javascript:evil()">链接</a>"""
                )
            ) {
                "data:image/png;base64,c3ludGhldGlj"
            }
        val doc = Jsoup.parse(output.html)
        assertEquals(0, doc.select("script,iframe,form,[onclick]").size)
        assertEquals(1, doc.select("img").size)
        assertTrue(doc.select("details").single().hasAttr("open"))
        assertTrue(doc.text().contains("123.45"))
        assertTrue(doc.text().contains("report.txt"))
        assertTrue(output.text.contains("copy@example.test"))
        assertTrue(output.text.contains("历史引用"))
        assertFalse(output.html.contains("remote.example.test"))
        assertFalse(output.html.contains("javascript:"))
    }

    @Test
    fun filenamesAndPlainMailAreSafe() {
        assertEquals("_CON", MailOutput.fileName("CON"))
        assertFalse(MailOutput.fileName("../../主题\n\u202e.pdf").contains('/'))
        assertFalse(MailOutput.fileName("../../主题\n\u202e.pdf").contains('\u202e'))
        val output = MailOutput.document(mail.copy(body = "<script>literal text</script>\n完整正文"))
        assertTrue(output.html.contains("&lt;script&gt;literal text&lt;/script&gt;"))
        assertEquals(0, Jsoup.parse(output.html).select("script").size)
    }
}
