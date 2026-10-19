package com.mailai.mobile

import com.mailai.mobile.mail.*
import java.util.Properties
import javax.mail.Session
import javax.mail.internet.*
import org.junit.Assert.*
import org.junit.Test

class ReadingContentTest {
    @Test
    fun darkMailChangesOnlyNeutralColorsAndKeepsSourceMarkupAndPictures() {
        val source =
            """<style>p{color:rgb(0, 0, 0);background-color:white}</style><table bgcolor="#ffffff"><tr><td style="background:#fefefe;color:#222">正文</td></tr></table><b style="color:#c00000">重点</b><img src="cid:logo"><p>签名</p>"""
        val light = MailHtml.prepare(source)
        val dark = MailHtml.prepare(source, true)
        val doc = org.jsoup.Jsoup.parse(dark.html)
        assertEquals("#1d2722", doc.selectFirst("table")!!.attr("bgcolor"))
        assertEquals("background:#1d2722;color:#eceee7", doc.selectFirst("td")!!.attr("style"))
        assertTrue(
            doc.select("style").any { it.data().contains("color:#eceee7;background-color:#1d2722") }
        )
        assertEquals("color:#c00000", doc.selectFirst("b")!!.attr("style"))
        assertEquals(light.images, dark.images)
        assertEquals(1, doc.select("table").size)
        assertTrue(light.html.contains("#ffffff"))
        assertTrue(dark.html.contains("user-select:text"))
    }

    @Test
    fun desktopWidthMailKeepsTableContentAndConfinesItsOverflow() {
        val html =
            "<div style='width:1200px'><table width='1200'><tr><td style='color:#a54a22'>完整内容</td><td><table><tr><td>嵌套表格</td></tr></table></td></tr></table></div>"
        val rendered = org.jsoup.Jsoup.parse(MailHtml.prepare(html).html)
        assertEquals(2, rendered.select("table").size)
        assertEquals(1, rendered.select("[data-mailai-table-scroll]").size)
        assertEquals("1200", rendered.selectFirst("table")!!.attr("width"))
        assertTrue(rendered.text().contains("完整内容"))
        assertEquals("color:#a54a22", rendered.selectFirst("td")!!.attr("style"))
        assertTrue(
            rendered.selectFirst("style[data-mailai-mobile]")!!.data().contains("overflow-x:auto")
        )
    }

    @Test
    fun encodedPeopleBecomeNamesAndAddressesWithoutQuotes() {
        val name = MimeUtility.encodeText("林安", "UTF-8", "B")
        val raw =
            "\"$name\" <lin@example.test>, \"${MimeUtility.encodeText("陈予", "UTF-8", "B")}\" <chen@example.test>"
        val people = MailAddresses.parse(raw)
        assertEquals(listOf("林安", "陈予"), people.map { it.name })
        assertEquals("lin@example.test", people[0].email)
        assertFalse(MailAddresses.display(raw).contains("=?"))
        assertEquals("研发通知", MailAddresses.sender("\"研发通知\" <notice@example.test>").label)
        assertEquals(2, MailAddresses.parse("Team: $raw;").size)
    }

    @Test
    fun recipientMergeDeduplicatesCaseAndProtectsLimit() {
        assertEquals(
            2,
            MailAddresses.parse(
                    MailAddresses.add(
                        "Lin <LIN@example.test>",
                        listOf(MailContact("lin@example.test"), MailContact("c@example.test", "陈予")),
                    )
                )
                .size,
        )
        try {
            MailAddresses.add("", (1..51).map { MailContact("p$it@example.test") })
            fail("recipient limit")
        } catch (_: IllegalArgumentException) {}
    }

    @Test
    fun alternativePreservesHtmlAndPlainAndRelatedContentId() {
        val html =
            "<table style='background:#f3eacb'><tr><td>项目</td><td>已完成</td></tr></table><img src='cid:logo'>"
        val alternative =
            MimeMultipart("alternative").apply {
                addBodyPart(MimeBodyPart().apply { setText("项目 已完成", "UTF-8") })
                addBodyPart(MimeBodyPart().apply { setContent(html, "text/html;charset=UTF-8") })
            }
        val related =
            MimeMultipart("related").apply {
                addBodyPart(MimeBodyPart().apply { setContent(alternative) })
                addBodyPart(
                    MimeBodyPart().apply {
                        setContent(byteArrayOf(1, 2, 3), "image/png")
                        setHeader("Content-ID", "<logo>")
                        disposition = "inline"
                    }
                )
            }
        val message =
            MimeMessage(Session.getInstance(Properties())).apply {
                setContent(related)
                saveChanges()
            }
        val content = MimeCodec.content(message)
        assertEquals("项目 已完成", content.text)
        assertEquals(html, content.html)
        assertEquals("logo", content.files.single().contentId)
        assertEquals("1", content.files.single().part)
    }

    @Test
    fun senderCannotDisableBodySelectionWhileOriginalAppearanceIsKept() {
        val html =
            "<style>p{color:#a54a22;user-select:none!important;font-size:18px}</style><p style='-webkit-user-select: none; background:#fff'>可以选中复制</p>"
        val rendered = MailHtml.prepare(html).html
        assertFalse(rendered.contains("user-select:none"))
        assertFalse(rendered.contains("user-select: none"))
        assertTrue(rendered.contains("user-select:text"))
        assertTrue(rendered.contains("color:#a54a22"))
        assertTrue(rendered.contains("font-size:18px"))
        assertTrue(rendered.contains("background:#fff"))
        assertTrue(rendered.contains("可以选中复制"))
    }

    @Test
    fun inlineHtmlFilenameDoesNotTurnBodyIntoAnAttachment() {
        val message =
            MimeMessage(Session.getInstance(Properties())).apply {
                setContent("<p>正文仍然显示</p>", "text/html;charset=UTF-8")
                fileName = "body.html"
                disposition = "inline"
                saveChanges()
            }
        val result = MimeCodec.content(message)
        assertTrue(result.html!!.contains("正文仍然显示"))
        assertTrue(result.files.isEmpty())
    }

    @Test
    fun mixedTextAndHtmlBothAppearInOriginalOrder() {
        val mixed =
            MimeMultipart("mixed").apply {
                addBodyPart(MimeBodyPart().apply { setText("前言 <确认>", "UTF-8") })
                addBodyPart(
                    MimeBodyPart().apply {
                        setContent(
                            "<table><tr><td>详情表格</td></tr></table>",
                            "text/html;charset=UTF-8",
                        )
                    }
                )
            }
        val message =
            MimeMessage(Session.getInstance(Properties())).apply {
                setContent(mixed)
                saveChanges()
            }
        val html = MimeCodec.content(message).html!!
        assertTrue(html.contains("前言 &lt;确认&gt;"))
        assertTrue(html.indexOf("前言") < html.indexOf("详情表格"))
    }

    @Test
    fun renderingRetainsLayoutButNeutralizesActiveContentAndResourceBypass() {
        val raw =
            """<html><head><style>@import url('https://evil.example/x.css'); td{color:#ab3421} .hero{background:url(cid:hero)}</style></head>
            <body onload="steal()"><table border="1"><tr><td style="font-size:20px">原始表格</td></tr></table>
            <img src="cid:logo" srcset="https://evil.example/bypass 2x"><img src="https://images.example/banner.png">
            <script>steal()</script><iframe src="file:///private"></iframe><form action="https://evil.example"><input></form>
            <a href="javascript:steal()">危险链接</a><a href="https://example.test/page">正常链接</a></body></html>"""
        val rendered = MailHtml.prepare(raw)
        assertTrue(rendered.html.contains("原始表格"))
        assertTrue(rendered.html.contains("<table"))
        assertTrue(rendered.html.contains("#ab3421"))
        assertFalse(rendered.html.contains("steal"))
        assertFalse(rendered.html.contains("srcset"))
        assertFalse(rendered.html.contains("@import"))
        assertFalse(rendered.html.contains("<form"))
        assertTrue(
            rendered.images.values.containsAll(
                listOf("cid:logo", "cid:hero", "https://images.example/banner.png")
            )
        )
        assertTrue(rendered.html.contains("Content-Security-Policy"))
        assertFalse(MailHtml.httpsImage("https://user:secret@images.example/x"))
        assertFalse(MailHtml.httpsImage("file:///private"))
        assertFalse(MailHtml.linkAllowed("javascript:alert(1)"))
    }
}
