package com.mailai.mobile.mail

import com.mailai.mobile.data.*
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import javax.activation.DataHandler
import javax.activation.FileDataSource
import javax.mail.*
import javax.mail.internet.*
import org.jsoup.Jsoup

object MimeCodec {
    fun fileName(raw: String?): String =
        runCatching { MimeUtility.decodeText(raw ?: "附件") }
            .getOrDefault("附件")
            .replace(Regex("[\\\\/\\p{Cntrl}]"), "_")
            .trim()
            .take(150)
            .ifBlank { "附件" }

    fun addresses(raw: String): Array<InternetAddress> {
        require(raw.isNotBlank() && '\r' !in raw && '\n' !in raw) { "请填写有效收件人地址" }
        return InternetAddress.parse(raw, true).also { list ->
            require(list.isNotEmpty() && list.size <= 50)
            list.forEach {
                it.validate()
                require(it.address.contains('@'))
            }
        }
    }

    fun copyBounded(
        input: InputStream,
        output: OutputStream,
        limit: Long,
        op: Operation,
        progress: (Long) -> Unit = {},
    ): Long {
        val bytes = ByteArray(32 * 1024)
        var count = 0L
        while (true) {
            op.check()
            val n = input.read(bytes)
            if (n < 0) break
            count += n
            require(count <= limit) { "文件超过 25 MB 限制" }
            output.write(bytes, 0, n)
            progress(count)
        }
        return count
    }

    private fun text(part: Part): String {
        val bytes =
            part.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (out.size() <= MAX_TEXT_BYTES) {
                    val n =
                        input.read(buffer, 0, minOf(buffer.size, MAX_TEXT_BYTES + 1 - out.size()))
                    if (n < 0) break
                    out.write(buffer, 0, n)
                }
                out.toByteArray()
            }
        require(bytes.size <= MAX_TEXT_BYTES) { "正文超过 2 MB，请使用其他客户端查看" }
        val encoding =
            runCatching {
                    java.nio.charset.Charset.forName(
                        ContentType(part.contentType).getParameter("charset") ?: "UTF-8"
                    )
                }
                .getOrDefault(Charsets.UTF_8)
        return bytes.toString(encoding)
    }

    fun read(root: Part): Pair<String, List<Attachment>> {
        val files = mutableListOf<Attachment>()
        var parts = 0
        var textSize = 0
        fun walk(p: Part, path: String, depth: Int): String {
            require(depth < 20 && ++parts <= 200) { "邮件结构过于复杂" }
            if (
                p.disposition.equals(Part.ATTACHMENT, true) ||
                    p.fileName != null ||
                    p.isMimeType("message/rfc822")
            ) {
                files +=
                    Attachment(
                        path,
                        fileName(p.fileName),
                        runCatching { ContentType(p.contentType).baseType }
                            .getOrDefault("application/octet-stream"),
                        p.size.toLong(),
                    )
                return ""
            }
            if (p.isMimeType("multipart/*")) {
                val mp = p.content as Multipart
                val values =
                    (0 until mp.count).map { i ->
                        walk(mp.getBodyPart(i), if (path.isBlank()) "$i" else "$path.$i", depth + 1)
                    }
                return if (p.isMimeType("multipart/alternative"))
                    values.firstOrNull { it.isNotBlank() }.orEmpty()
                else values.filter(String::isNotBlank).joinToString("\n\n")
            }
            if (p.isMimeType("text/plain") || p.isMimeType("text/html")) {
                val value = text(p)
                textSize += value.length
                require(textSize <= MAX_TEXT_BYTES)
                return if (p.isMimeType("text/html"))
                    Jsoup.parse(value)
                        .apply {
                            select("script,style,iframe,object,form").remove()
                            select("br").append("\\n")
                            select("p,div,li").prepend("\\n")
                        }
                        .text()
                        .replace("\\n", "\n")
                else value
            }
            return ""
        }
        return walk(root, "", 0).ifBlank { "这封邮件没有可显示的文本正文。" } to files
    }

    fun part(root: Part, path: String): Part {
        if (path.isBlank()) return root
        require(path.matches(Regex("\\d+(\\.\\d+)*")))
        return path.split('.').fold(root) { p, index ->
            (p.content as Multipart).getBodyPart(index.toInt())
        }
    }

    fun outgoing(
        session: Session,
        account: Account,
        draft: Draft,
        file: (String) -> File,
    ): MimeMessage {
        require(draft.subject.none { it == '\r' || it == '\n' })
        require(draft.body.isNotBlank() || draft.attachments.isNotEmpty()) { "请填写正文或添加附件" }
        return object : MimeMessage(session) {
                override fun updateMessageID() {
                    setHeader("Message-ID", draft.messageId)
                }
            }
            .apply {
                setFrom(
                    InternetAddress(account.email, account.name.ifBlank { account.email }, "UTF-8")
                )
                setRecipients(Message.RecipientType.TO, addresses(draft.to))
                setSubject(draft.subject, "UTF-8")
                sentDate = java.util.Date()
                if (
                    draft.replyId.isNotBlank() &&
                        !draft.replyId.contains('\n') &&
                        !draft.replyId.contains('\r')
                ) {
                    setHeader("In-Reply-To", draft.replyId)
                    setHeader("References", draft.replyId)
                }
                if (draft.attachments.isEmpty()) setText(draft.body, "UTF-8")
                else {
                    val mixed = MimeMultipart("mixed")
                    mixed.addBodyPart(MimeBodyPart().apply { setText(draft.body, "UTF-8") })
                    require(
                        draft.attachments.sumOf { file(it.local).length() } <= MAX_ATTACHMENT_BYTES
                    ) {
                        "附件合计不能超过 25 MB"
                    }
                    draft.attachments.forEach { attachment ->
                        mixed.addBodyPart(
                            MimeBodyPart().apply {
                                val source = file(attachment.local)
                                require(source.isFile)
                                dataHandler =
                                    DataHandler(
                                        object : FileDataSource(source) {
                                            override fun getContentType() = attachment.type
                                        }
                                    )
                                fileName = MimeUtility.encodeText(attachment.name, "UTF-8", null)
                                disposition = Part.ATTACHMENT
                            }
                        )
                    }
                    setContent(mixed)
                }
                saveChanges()
            }
    }
}
