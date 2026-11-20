package com.mailai.mobile.mail

import javax.mail.internet.InternetAddress

/** Decode display names at both the network and cache boundary (old caches contain raw headers). */
data class MailContact(val email: String, val name: String = "") {
    val label: String
        get() = name.ifBlank { email }

    fun address(): String =
        if (name.isBlank()) email else InternetAddress(email, name, "UTF-8").toUnicodeString()
}

object MailAddresses {
    fun decode(value: String): String {
        var name = MailHeaderCodec.decode(value).replace(Regex("[\r\n]+[\t ]*"), " ").trim()
        // Legacy servers may escape the enclosing display-name quotes more than once.
        // Only balanced wrappers are removed, preserving punctuation inside the name.
        repeat(8) {
            val unwrapped = name.removeSurrounding("\\\"").removeSurrounding("\"").trim()
            if (unwrapped == name) return name
            name = unwrapped
        }
        return name
    }

    fun parse(raw: String): List<MailContact> {
        if (raw.isBlank()) return emptyList()
        fun expand(a: InternetAddress): List<InternetAddress> =
            if (a.isGroup) runCatching { a.getGroup(false).toList() }.getOrDefault(emptyList())
            else listOf(a)
        return runCatching {
                InternetAddress.parseHeader(MailHeaderCodec.normalizeWords(raw), false)
                    .flatMap(::expand)
            }
            .getOrDefault(emptyList())
            .mapNotNull { address ->
                val rawEmail = address.address?.trim().orEmpty()
                val email =
                    if (address.personal.isNullOrBlank() &&
                        rawEmail.startsWith("\\\"") && rawEmail.endsWith("\\\"")) {
                        decode(rawEmail)
                    } else rawEmail
                if (!email.contains('@') || email.any { it == '\r' || it == '\n' }) null
                else MailContact(email, decode(address.personal.orEmpty()))
            }
            .distinctBy { it.email.lowercase(java.util.Locale.ROOT) }
    }

    fun display(raw: String): String =
        parse(raw).joinToString { it.address() }.ifBlank { decode(raw) }

    fun sender(raw: String): MailContact = parse(raw).firstOrNull() ?: MailContact("", decode(raw))

    fun add(raw: String, selected: List<MailContact>): String =
        (parse(raw) + selected)
            .distinctBy { it.email.lowercase(java.util.Locale.ROOT) }
            .also { require(it.size <= 50) { "单封邮件最多添加 50 位收件人" } }
            .joinToString { it.address() }
}
