package com.mailai.mobile.mail

import com.mailai.mobile.data.MailItem
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist

/** Self-contained, light paper document. Never fetch external resources for output. */
object MailOutput {
    data class Document(val html: String, val text: String, val name: String)

    fun fileName(subject: String): String {
        val clean =
            subject
                .replace(Regex("[<>:\"/\\\\|?*\\p{Cntrl}\\u202a-\\u202e\\u2066-\\u2069]"), "_")
                .trim(' ', '.')
                .take(70)
                .ifBlank { "邮件" }
        return if (
            clean.substringBefore('.').matches(Regex("(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])"))
        )
            "_$clean"
        else clean
    }

    fun document(mail: MailItem, inlineImage: (String) -> String? = { null }): Document {
        require(mail.body != null || mail.html != null) { "邮件正文尚未下载，请先读取完整邮件" }
        val body = Jsoup.parse(mail.html ?: "")
        body.select("script,style,head,iframe,object,embed,svg,math,form,template").remove()
        var omitted = false
        body.select("img").forEach { image ->
            val src = image.attr("src")
            val local =
                if (src.startsWith("cid:", true)) inlineImage(src.substring(4).trim('<', '>'))
                else if (
                    src.startsWith("data:image/", true) &&
                        !src.startsWith("data:image/svg", true) &&
                        src.length < 4 * 1024 * 1024
                )
                    src
                else null
            if (local != null) image.attr("src", local)
            else {
                omitted = true
                image.tagName("span").text(image.attr("alt")).clearAttributes()
            }
        }
        val allowedCss =
            setOf(
                "color",
                "background-color",
                "font-family",
                "font-size",
                "font-weight",
                "font-style",
                "text-align",
                "text-decoration",
                "vertical-align",
                "line-height",
                "padding",
                "margin",
                "border",
                "border-color",
                "border-collapse",
            )
        body.select("[style]").forEach { node ->
            val safe =
                node
                    .attr("style")
                    .split(';')
                    .filter { part ->
                        part.substringBefore(':').trim().lowercase() in allowedCss &&
                            !Regex("(?i)url|expression|@|\\\\").containsMatchIn(part)
                    }
                    .joinToString(";")
            node.attr("style", safe)
        }
        body.select("details").attr("open", "open")
        val safelist =
            Safelist.relaxed()
                .addTags(
                    "details",
                    "summary",
                    "thead",
                    "tbody",
                    "tfoot",
                    "th",
                    "td",
                    "colgroup",
                    "col",
                    "pre",
                )
                .addAttributes(":all", "style", "dir")
                .addAttributes("details", "open")
                .addProtocols("img", "src", "data")
                .removeProtocols("img", "src", "http", "https")
        val rich =
            if (mail.html != null) Jsoup.clean(body.body().html(), safelist)
            else "<pre>${escape(mail.body.orEmpty())}</pre>"
        val date = SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.CHINA).format(Date(mail.date))
        val headers =
            listOf(
                    "发件人" to MailHeaderCodec.decode(mail.sender),
                    "收件人" to MailHeaderCodec.decode(mail.recipients),
                    "抄送" to MailHeaderCodec.decode(mail.cc),
                    "时间" to date,
                )
                .filter { it.second.isNotBlank() }
        val files =
            mail.attachments.filter {
                it.contentId.isBlank() || !it.type.startsWith("image/", true)
            }
        val attachments =
            if (files.isEmpty()) ""
            else
                "<section class='mail-output-attachments'><b>附件</b><ul>" +
                    files.joinToString("") { "<li>${escape(it.name)} (${it.size} B)</li>" } +
                    "</ul></section>"
        val note = if (omitted) "<p class='note'>外部或不可用图片未包含在输出中，未额外联网加载。</p>" else ""
        val html =
            """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';img-src data:;style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><style>
            @page{size:A4;margin:16mm}*{box-sizing:border-box}html{color-scheme:light;background:white;color:#202824}body{margin:0;padding:16px;font:14px/1.65 sans-serif;overflow-wrap:anywhere}
            header{border-bottom:1px solid #ccd4ce;padding-bottom:12px;margin-bottom:16px}header p{margin:4px 0}h1{font-size:22px;line-height:1.4}main *{max-width:100%!important;min-width:0!important;overflow:visible!important}table{width:100%!important;table-layout:fixed!important;border-collapse:collapse}td,th{overflow-wrap:anywhere!important;white-space:normal!important}img{max-width:100%!important;height:auto!important}pre{white-space:pre-wrap!important}blockquote{margin:12px 0;padding-left:12px;border-left:2px solid #bbc8c0}.mail-output-attachments{margin-top:24px}.note{font-size:12px;color:#66736c}@media print{body{padding:0}tr{break-inside:avoid}thead{display:table-header-group}}
            </style></head><body><header><h1>${escape(mail.subject.ifBlank { "（无主题）" })}</h1>${headers.joinToString("") { "<p><b>${it.first}</b> ${escape(it.second)}</p>" }}</header><main>$rich</main>$attachments$note</body></html>"""
        val text =
            "主题: ${mail.subject}\n" +
                headers.joinToString("\n") { "${it.first}: ${it.second}" } +
                "\n\n" +
                (mail.body ?: body.body().wholeText()) +
                if (files.isEmpty()) ""
                else "\n\n附件:\n" + files.joinToString("\n") { "${it.name} (${it.size} B)" }
        return Document(html, text, fileName(mail.subject))
    }

    private fun escape(value: String): String = org.jsoup.nodes.Entities.escape(value)
}
