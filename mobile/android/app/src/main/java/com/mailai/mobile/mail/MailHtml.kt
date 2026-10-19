package com.mailai.mobile.mail

import java.net.URI
import org.jsoup.Jsoup

/** Inert rendering document; original HTML is retained separately in the mail cache. */
object MailHtml {
    const val ORIGIN = "https://mailai.invalid/"

    data class Document(val html: String, val images: Map<String, String>)

    fun prepare(raw: String): Document {
        val doc = Jsoup.parse(raw)
        doc.select(
                "script,iframe,frame,frameset,object,embed,form,input,button,textarea,select,link,base,meta,audio,video,source,svg,math"
            )
            .remove()
        val images = linkedMapOf<String, String>()
        fun image(value: String): String {
            val source = value.trim()
            if (
                source.startsWith("data:image/", true) && !source.startsWith("data:image/svg", true)
            )
                return source
            if (!source.startsWith("cid:", true) && !httpsImage(source)) return ""
            val target = "${ORIGIN}image/${images.size}"
            images[target] = source
            return target
        }
        doc.allElements.forEach { e ->
            e.attributes().asList().forEach { attr ->
                val key = attr.key.lowercase()
                if (
                    key.startsWith("on") ||
                        key in
                            setOf(
                                "srcdoc",
                                "srcset",
                                "ping",
                                "action",
                                "formaction",
                                "integrity",
                                "nonce",
                            )
                )
                    e.removeAttr(attr.key)
            }
            if (e.hasAttr("href")) {
                val href = e.attr("href").trim()
                if (!linkAllowed(href)) e.removeAttr("href")
            }
            if (e.hasAttr("src")) {
                if (e.tagName() == "img") e.attr("src", image(e.attr("src")))
                else e.removeAttr("src")
            }
            if (e.hasAttr("background")) e.attr("background", image(e.attr("background")))
        }
        // URL resources in CSS remain subject to CSP; rewrite normal url() images to the same
        // image-only handler. Remove imports (no third-party CSS or JavaScript can be executed).
        fun css(value: String): String =
            value.replace(Regex("(?is)@import[^;]*;?"), "").replace(
                Regex("(?is)url\\(\\s*(['\"]?)(.*?)\\1\\s*\\)")
            ) { match ->
                val target = image(match.groupValues[2])
                if (target.isEmpty()) "none" else "url('$target')"
            }
        doc.select("style").forEach { it.html(css(it.data())) }
        doc.select("[style]").forEach { it.attr("style", css(it.attr("style"))) }
        doc.head().prependElement("meta").attr("charset", "utf-8")
        doc.head()
            .appendElement("meta")
            .attr("name", "viewport")
            .attr("content", "width=device-width,initial-scale=1,user-scalable=yes")
        doc.head()
            .appendElement("meta")
            .attr("http-equiv", "Content-Security-Policy")
            .attr(
                "content",
                "default-src 'none'; img-src https://mailai.invalid data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
            )
        doc.head()
            .prependElement("style")
            .text(
                "html{overflow-wrap:anywhere}body{margin:12px;font-family:system-ui,sans-serif}img{max-width:100%;height:auto}pre{white-space:pre-wrap}"
            )
        return Document(doc.outerHtml(), images)
    }

    fun httpsImage(value: String): Boolean =
        runCatching {
                val u = URI(value)
                u.scheme.equals("https", true) &&
                    !u.host.isNullOrBlank() &&
                    u.rawUserInfo == null &&
                    (u.port == -1 || u.port == 443)
            }
            .getOrDefault(false)

    fun linkAllowed(value: String): Boolean =
        runCatching {
                val u = URI(value)
                (u.scheme in setOf("https", "http") &&
                    !u.host.isNullOrBlank() &&
                    u.rawUserInfo == null) || u.scheme == "mailto"
            }
            .getOrDefault(false)
}
