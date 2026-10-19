package com.mailai.mobile.data

/** Known public providers only; never guess an enterprise endpoint for a credential submission. */
data class MailProfile(
    val label: String,
    val domains: Set<String>,
    val imap: String,
    val smtp: String,
)

object AccountSetup {
    private val profiles =
        listOf(
            MailProfile(
                "QQ / Foxmail 邮箱",
                setOf("qq.com", "foxmail.com"),
                "imap.qq.com",
                "smtp.qq.com",
            ),
            MailProfile("163 邮箱", setOf("163.com"), "imap.163.com", "smtp.163.com"),
            MailProfile("126 邮箱", setOf("126.com"), "imap.126.com", "smtp.126.com"),
        )

    fun domain(email: String) =
        email.trim().substringAfterLast('@', "").lowercase(java.util.Locale.ROOT)

    fun profile(email: String) = profiles.firstOrNull { domain(email) in it.domains }

    fun requireMatchingProvider(account: Account) {
        val domain = domain(account.email)
        for (profile in profiles) {
            if (
                (account.imap.host.trim().equals(profile.imap, true) ||
                    account.smtp.host.trim().equals(profile.smtp, true)) &&
                    domain !in profile.domains
            ) {
                throw IllegalArgumentException("邮箱地址与${profile.label}服务器不匹配，请填写这个邮箱实际使用的收发服务器")
            }
        }
    }
}
