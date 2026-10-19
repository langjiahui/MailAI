package com.mailai.mobile.data

import java.net.URI

enum class BodyStyleKind {
    BOLD,
    ITALIC,
    UNDERLINE,
    SIZE,
    COLOR,
    LINK,
}

data class BodyStyle(val start: Int, val end: Int, val kind: BodyStyleKind, val value: String = "")

/** Formatting is data attached to plain text, never executable HTML from the editor. */
object RichBody {
    private val sizes = setOf("14", "16", "18", "20")
    val colors = listOf("#176648", "#122338", "#A33F35")

    fun safeLink(value: String): Boolean =
        runCatching {
                val u = URI(value)
                value.length <= 2048 &&
                    u.scheme.equals("https", true) &&
                    !u.host.isNullOrBlank() &&
                    u.userInfo == null &&
                    value.none { it.isISOControl() }
            }
            .getOrDefault(false)

    fun valid(s: BodyStyle, length: Int): Boolean =
        s.start >= 0 &&
            s.end > s.start &&
            s.end <= length &&
            when (s.kind) {
                BodyStyleKind.SIZE -> s.value in sizes
                BodyStyleKind.COLOR -> s.value in colors
                BodyStyleKind.LINK -> safeLink(s.value)
                else -> s.value.isEmpty()
            }

    fun clean(text: String, styles: List<BodyStyle>): List<BodyStyle> =
        styles
            .filter { valid(it, text.length) }
            .take(512)
            .groupBy { it.kind to it.value }
            .flatMap { (_, group) ->
                val result = mutableListOf<BodyStyle>()
                group
                    .sortedBy { it.start }
                    .forEach { s ->
                        val last = result.lastOrNull()
                        if (last != null && last.end >= s.start)
                            result[result.lastIndex] = last.copy(end = maxOf(last.end, s.end))
                        else result.add(s)
                    }
                result
            }
            .sortedWith(compareBy({ it.start }, { it.end }, { it.kind.ordinal }))

    fun apply(
        text: String,
        styles: List<BodyStyle>,
        start: Int,
        end: Int,
        kind: BodyStyleKind,
        value: String = "",
        toggle: Boolean = true,
    ): List<BodyStyle> {
        if (start >= end) return styles
        val normalized = clean(text, styles)
        val covered =
            normalized.any {
                it.kind == kind && it.value == value && it.start <= start && it.end >= end
            }
        val result =
            normalized
                .flatMap { s ->
                    if (s.kind != kind || s.end <= start || s.start >= end) listOf(s)
                    else
                        listOfNotNull(
                            if (s.start < start) s.copy(end = start) else null,
                            if (s.end > end) s.copy(start = end) else null,
                        )
                }
                .toMutableList()
        if (!covered || !toggle) result.add(BodyStyle(start, end, kind, value))
        require(result.size <= 512) { "格式较多，请先清除部分格式" }
        return clean(text, result)
    }

    fun clear(
        text: String,
        styles: List<BodyStyle>,
        start: Int,
        end: Int,
        kind: BodyStyleKind,
    ): List<BodyStyle> =
        clean(
            text,
            styles.flatMap { s ->
                if (s.kind != kind || s.end <= start || s.start >= end) listOf(s)
                else
                    listOfNotNull(
                        if (s.start < start) s.copy(end = start) else null,
                        if (s.end > end) s.copy(start = end) else null,
                    )
            },
        )

    /** Move existing ranges across insertions, replacements, deletions, paste and IME edits. */
    fun edit(old: String, text: String, styles: List<BodyStyle>): List<BodyStyle> {
        if (old == text) return styles
        val prefix = old.commonPrefixWith(text).length
        val suffix = old.substring(prefix).commonSuffixWith(text.substring(prefix)).length
        val oldEnd = old.length - suffix
        val newEnd = text.length - suffix
        val delta = newEnd - oldEnd
        return clean(
            text,
            styles.map { s ->
                val start =
                    when {
                        s.start <= prefix -> s.start
                        s.start >= oldEnd -> s.start + delta
                        else -> prefix
                    }
                val end =
                    when {
                        s.end < prefix -> s.end
                        s.end >= oldEnd -> s.end + delta
                        else -> newEnd
                    }
                s.copy(start = start.coerceAtLeast(0), end = end.coerceAtMost(text.length))
            },
        )
    }

    private fun escape(text: String) = buildString {
        text.forEach {
            append(
                when (it) {
                    '&' -> "&amp;"
                    '<' -> "&lt;"
                    '>' -> "&gt;"
                    '"' -> "&quot;"
                    '\'' -> "&#39;"
                    else -> it.toString()
                }
            )
        }
    }

    fun html(text: String, styles: List<BodyStyle>): String? {
        val ranges = clean(text, styles)
        if (ranges.isEmpty()) return null
        val boundaries =
            (listOf(0, text.length) + ranges.flatMap { listOf(it.start, it.end) })
                .distinct()
                .sorted()
        return buildString {
            append(
                "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body><div style=\"white-space:pre-wrap;overflow-wrap:anywhere\">"
            )
            boundaries.zipWithNext().forEach { (start, end) ->
                val active = ranges.filter { it.start <= start && it.end >= end }
                val css =
                    active
                        .mapNotNull {
                            when (it.kind) {
                                BodyStyleKind.BOLD -> "font-weight:bold"
                                BodyStyleKind.ITALIC -> "font-style:italic"
                                BodyStyleKind.UNDERLINE -> "text-decoration:underline"
                                BodyStyleKind.SIZE -> "font-size:${it.value}px"
                                BodyStyleKind.COLOR -> "color:${it.value}"
                                else -> null
                            }
                        }
                        .joinToString(";")
                val link = active.lastOrNull { it.kind == BodyStyleKind.LINK }
                if (link != null) append("<a href=\"${escape(link.value)}\">")
                if (css.isNotEmpty()) append("<span style=\"$css\">")
                append(escape(text.substring(start, end)))
                if (css.isNotEmpty()) append("</span>")
                if (link != null) append("</a>")
            }
            append("</div></body></html>")
        }
    }
}
