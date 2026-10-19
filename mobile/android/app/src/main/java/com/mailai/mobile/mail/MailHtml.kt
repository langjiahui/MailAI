package com.mailai.mobile.mail

import java.net.URI
import org.jsoup.Jsoup

/** Inert rendering document; original HTML is retained separately in the mail cache. */
object MailHtml {
    const val ORIGIN = "https://mailai.invalid/"

    data class Document(val html: String, val images: Map<String, String>)

    fun prepare(raw: String, dark: Boolean = false): Document {
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
            value
                .replace(Regex("(?is)@import[^;]*;?"), "")
                .replace(Regex("(?i)(^|(?<=[;{]))\\s*(?:-webkit-)?user-select\\s*:[^;}]*"), "")
                .replace(Regex("(?is)url\\(\\s*(['\"]?)(.*?)\\1\\s*\\)")) { match ->
                    val target = image(match.groupValues[2])
                    if (target.isEmpty()) "none" else "url('$target')"
                }
        doc.select("style").forEach { it.html(css(it.data())) }
        doc.select("[style]").forEach { it.attr("style", css(it.attr("style"))) }
        if (dark) adaptNeutralColors(doc)
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
                "html{overflow-wrap:anywhere}body{margin:12px;font-family:system-ui,sans-serif;-webkit-user-select:text;user-select:text}img{max-width:100%;height:auto}pre{white-space:pre-wrap}"
            )
        // Fixed-width desktop mail must not make the entire reading pane pan horizontally.
        // Keep table markup intact and confine unavoidable overflow to that table's own region.
        doc.select("table")
            .filter { table -> table.parents().none { it.tagName() == "table" } }
            .forEach { it.wrap("<div data-mailai-table-scroll='true'></div>") }
        doc.head()
            .appendElement("style")
            .attr("data-mailai-mobile", "true")
            .text(
                """
                html{box-sizing:border-box;width:100%;overflow-wrap:anywhere}
                body{box-sizing:border-box;width:auto!important;min-width:0!important;max-width:100%!important;margin:0!important;padding:16px!important;overflow-wrap:anywhere}
                div,p,section,article,center,blockquote,span{box-sizing:border-box;min-width:0!important;max-width:100%!important}
                table{max-width:100%!important;min-width:0!important}
                td,th{overflow-wrap:break-word}
                img{max-width:100%!important;height:auto!important}
                pre{white-space:pre-wrap!important;overflow-wrap:anywhere}
                [data-mailai-table-scroll]{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:auto!important;scrollbar-width:none;overscroll-behavior-x:contain}
                ::-webkit-scrollbar{display:none;width:0;height:0}
                """
                    .trimIndent()
            )
        if (dark)
            doc.head()
                .appendElement("style")
                .attr("data-mailai-theme", "dark")
                .text(
                    "html,body{background:#1d2722!important;color:#eceee7!important;color-scheme:dark}a{color:#9cdbbc}blockquote{border-color:#526157!important}"
                )
        return Document(doc.outerHtml(), images)
    }

    // Only neutral light backgrounds and neutral dark text change. Brand colors, pictures,
    // spacing, tables and the stored source stay intact; this is a rendering-only adaptation.
    private fun adaptNeutralColors(doc: org.jsoup.nodes.Document) {
        fun neutral(value: String, background: Boolean): String {
            val clean = value.trim().lowercase().removeSuffix("!important").trim()
            val rgb =
                when {
                    clean == "white" -> listOf(255, 255, 255)
                    clean == "black" -> listOf(0, 0, 0)
                    clean.matches(Regex("#[0-9a-f]{3}")) -> clean.drop(1).map { "$it$it".toInt(16) }
                    clean.matches(Regex("#[0-9a-f]{6}")) ->
                        clean.drop(1).chunked(2).map { it.toInt(16) }
                    clean.matches(Regex("rgb\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\)")) ->
                        Regex("\\d+").findAll(clean).map { it.value.toInt() }.toList()
                    else -> return value
                }
            if (rgb.max() - rgb.min() > 24) return value
            val level = rgb.average()
            val mapped =
                if (background && level >= 180) "#1d2722"
                else if (!background && level <= 120) (if (level < 75) "#eceee7" else "#abb2a6")
                else return value
            return mapped + if (value.contains("!important", true)) "!important" else ""
        }
        fun css(value: String) =
            Regex("(?i)(?<![\\w-])(background-color|background|color)\\s*:\\s*([^;{}]+)").replace(
                value
            ) { m ->
                m.groupValues[1] +
                    ":" +
                    neutral(m.groupValues[2], m.groupValues[1].startsWith("background", true))
            }
        doc.select("style").forEach { it.html(css(it.data())) }
        doc.select("[style]").forEach { it.attr("style", css(it.attr("style"))) }
        doc.select("[bgcolor]").forEach { it.attr("bgcolor", neutral(it.attr("bgcolor"), true)) }
        doc.select("[color]").forEach { it.attr("color", neutral(it.attr("color"), false)) }
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
