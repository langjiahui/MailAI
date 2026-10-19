package com.mailai.mobile.mail

import com.mailai.mobile.data.*
import java.util.Locale

internal enum class MailFilter(val title: String) {
    ALL("全部"),
    UNREAD("未读"),
    STARRED("星标邮件"),
    ATTACHMENTS("附件邮件"),
}

internal enum class SearchScope(val title: String) {
    ALL("全部"),
    SENDER("发件人"),
    SUBJECT("主题"),
    ATTACHMENTS("附件"),
}

internal fun MailItem.visibleAttachments() =
    attachments.filter {
        it.contentId.isBlank() || !it.type.startsWith("image/", true) || it.local.isBlank()
    }

internal fun MailItem.matches(query: String, scope: SearchScope): Boolean {
    val q = query.trim()
    if (q.isEmpty()) return false
    return when (scope) {
        SearchScope.SENDER -> MailAddresses.display(sender).contains(q, true)
        SearchScope.SUBJECT -> subject.contains(q, true)
        SearchScope.ATTACHMENTS -> visibleAttachments().any { it.name.contains(q, true) }
        SearchScope.ALL ->
            matches(q, SearchScope.SENDER) ||
                matches(q, SearchScope.SUBJECT) ||
                matches(q, SearchScope.ATTACHMENTS) ||
                body.orEmpty().contains(q, true)
    }
}

/** Reply-all excludes the current mailbox and deduplicates addresses across To and Cc. */
internal fun replyRecipients(mail: MailItem, ownAddress: String, all: Boolean): String {
    val primary = MailAddresses.parse(mail.replyTo).ifEmpty { MailAddresses.parse(mail.sender) }
    val people =
        if (all) primary + MailAddresses.parse(mail.recipients) + MailAddresses.parse(mail.cc)
        else primary
    val recipients =
        people
            .filterNot { it.email.equals(ownAddress, true) }
            .distinctBy { it.email.lowercase(Locale.ROOT) }
    require(recipients.size <= 50) { "收件人超过 50 位，请手动选择本次回复对象" }
    return recipients.joinToString { it.address() }
}

internal fun quotedForward(mail: MailItem): String = buildString {
    append("\n\n---------- 转发的邮件 ----------\n")
    append("发件人：${MailAddresses.display(mail.sender)}\n")
    append("主题：${mail.subject}\n")
    append("收件人：${MailAddresses.display(mail.recipients)}\n\n")
    append(mail.body.orEmpty())
}
