package com.mailai.mobile.mail

import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeUtility

/** Decode display names at both the network and cache boundary (old caches contain raw headers). */
data class MailContact(val email: String, val name: String = "") {
    val label: String
        get() = name.ifBlank { email }

    fun address(): String =
        if (name.isBlank()) email else InternetAddress(email, name, "UTF-8").toUnicodeString()
}

object MailAddresses {
    fun decode(value: String): String =
        runCatching { MimeUtility.decodeText(value) }
            .getOrDefault(value)
            .replace(Regex("[\\r\\n]+[\\t ]*"), " ")
            .trim()
            .removeSurrounding("\"")

    fun parse(raw: String): List<MailContact> {
        if (raw.isBlank()) return emptyList()
        fun expand(a: InternetAddress): List<InternetAddress> =
            if (a.isGroup) runCatching { a.getGroup(false).toList() }.getOrDefault(emptyList())
            else listOf(a)
        return runCatching { InternetAddress.parseHeader(raw, false).flatMap(::expand) }
            .getOrDefault(emptyList())
            .mapNotNull { address ->
                val email = address.address?.trim().orEmpty()
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
