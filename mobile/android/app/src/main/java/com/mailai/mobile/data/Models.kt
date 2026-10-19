package com.mailai.mobile.data

import java.util.UUID

enum class Security {
    TLS,
    STARTTLS,
}

data class Server(
    val host: String = "",
    val port: Int = 993,
    val security: Security = Security.TLS,
)

data class Account(
    val id: String = UUID.randomUUID().toString(),
    val email: String,
    val name: String = "",
    val username: String = email,
    val imap: Server,
    val smtp: Server,
)

data class Attachment(
    val part: String,
    val name: String,
    val type: String,
    val size: Long = -1,
    val local: String = "",
    val contentId: String = "",
)

data class MailItem(
    val key: String,
    val folder: String,
    val validity: Long,
    val uid: Long,
    val sender: String,
    val replyTo: String,
    val recipients: String,
    val subject: String,
    val date: Long,
    val unread: Boolean,
    val body: String? = null,
    val attachments: List<Attachment> = emptyList(),
    val messageId: String = "",
    val html: String? = null,
    val cc: String = "",
    val contentVersion: Int = 1,
    val starred: Boolean = false,
)

enum class SendState {
    DRAFT,
    CONNECTING,
    TRANSMITTING,
    FAILED,
    UNCERTAIN,
    SENT,
}

data class Draft(
    val id: String = UUID.randomUUID().toString(),
    val to: String = "",
    val subject: String = "",
    val body: String = "",
    val attachments: List<Attachment> = emptyList(),
    val state: SendState = SendState.DRAFT,
    val messageId: String = "<${UUID.randomUUID()}@mailai.local>",
    val replyId: String = "",
    val updated: Long = System.currentTimeMillis(),
    val cc: String = "",
    val bcc: String = "",
    val styles: List<BodyStyle> = emptyList(),
)

const val MAX_ATTACHMENT_BYTES = 25L * 1024 * 1024
const val MAX_TEXT_BYTES = 2 * 1024 * 1024
