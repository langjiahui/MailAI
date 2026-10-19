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

    data class Content(val text: String, val html: String?, val files: List<Attachment>)

    fun read(root: Part): Pair<String, List<Attachment>> = content(root).let { it.text to it.files }

    fun content(root: Part): Content {
        val files = mutableListOf<Attachment>()
        var parts = 0
        var textSize = 0
        data class Body(val plain: String = "", val html: String? = null)
        fun walk(p: Part, path: String, depth: Int): Body {
            require(depth < 20 && ++parts <= 200) { "邮件结构过于复杂" }
            val cid =
                p.getHeader("Content-ID")
                    ?.firstOrNull()
                    ?.trim()
                    ?.removeSurrounding("<", ">")
                    .orEmpty()
            if (
                p.disposition.equals(Part.ATTACHMENT, true) ||
                    (p.fileName != null &&
                        !p.isMimeType("text/html") &&
                        !p.isMimeType("text/plain")) ||
                    p.isMimeType("message/rfc822") ||
                    (cid.isNotBlank() && p.isMimeType("image/*"))
            ) {
                files +=
                    Attachment(
                        path,
                        fileName(p.fileName ?: if (cid.isNotBlank()) "内嵌图片" else null),
                        runCatching {
                                ContentType(p.contentType).baseType.lowercase(java.util.Locale.ROOT)
                            }
                            .getOrDefault("application/octet-stream"),
                        p.size.toLong(),
                        contentId = cid,
                    )
                return Body()
            }
            if (p.isMimeType("multipart/*")) {
                val mp = p.content as Multipart
                val values =
                    (0 until mp.count).map { i ->
                        walk(mp.getBodyPart(i), if (path.isBlank()) "$i" else "$path.$i", depth + 1)
                    }
                return if (p.isMimeType("multipart/alternative"))
                    Body(
                        values.firstOrNull { it.plain.isNotBlank() }?.plain.orEmpty(),
                        values.lastOrNull { it.html != null }?.html,
                    )
                else
                    Body(
                        values.map { it.plain }.filter(String::isNotBlank).joinToString("\n\n"),
                        if (values.any { it.html != null })
                            values
                                .map {
                                    it.html
                                        ?: if (it.plain.isBlank()) ""
                                        else
                                            "<div style='white-space:pre-wrap'>${org.jsoup.nodes.Entities.escape(it.plain)}</div>"
                                }
                                .filter(String::isNotBlank)
                                .joinToString("<br><br>")
                        else null,
                    )
            }
            if (p.isMimeType("text/plain") || p.isMimeType("text/html")) {
                val value = text(p)
                textSize += value.length
                require(textSize <= MAX_TEXT_BYTES) { "正文超过 2 MB，请使用其他客户端查看" }
                return if (p.isMimeType("text/html")) Body(html = value) else Body(plain = value)
            }
            return Body()
        }
        val result = walk(root, "", 0)
        val plain =
            result.plain
                .ifBlank {
                    result.html
                        ?.let {
                            Jsoup.parse(it)
                                .apply {
                                    select("script,style,iframe,object,form").remove()
                                    select("br").append("\\n")
                                    select("p,div,li,tr").prepend("\\n")
                                }
                                .text()
                                .replace("\\n", "\n")
                        }
                        .orEmpty()
                }
                .ifBlank { "这封邮件没有可显示的文本正文。" }
        return Content(plain, result.html, files)
    }

    fun part(root: Part, path: String): Part {
        if (path.isBlank()) return root
        require(path.matches(Regex("\\d+(\\.\\d+)*")))
        return path.split('.').fold(root) { p, index ->
            (p.content as Multipart).getBodyPart(index.toInt())
        }
    }

    /**
     * Validate all envelopes together, including optional fields; no Bcc header goes on the wire.
     */
    fun recipients(draft: Draft): List<Pair<Message.RecipientType, Array<InternetAddress>>> {
        val groups =
            listOf(
                Message.RecipientType.TO to draft.to,
                Message.RecipientType.CC to draft.cc,
                Message.RecipientType.BCC to draft.bcc,
            )
        val seen = mutableSetOf<String>()
        val parsed =
            groups.map { (type, raw) ->
                type to
                    (if (raw.isBlank() && type != Message.RecipientType.TO) emptyArray()
                        else addresses(raw))
                        .filter { seen.add(it.address.lowercase(java.util.Locale.ROOT)) }
                        .toTypedArray()
            }
        require(seen.size <= 50) { "收件人、抄送和密送合计最多 50 人" }
        return parsed
    }

    fun outgoing(
        session: Session,
        account: Account,
        draft: Draft,
        file: (String) -> File,
    ): MimeMessage {
        require(draft.subject.none { it == '\r' || it == '\n' })
        require(draft.body.isNotBlank() || draft.attachments.isNotEmpty()) { "请填写正文或添加附件" }
        val targets = recipients(draft)
        val html = RichBody.html(draft.body, draft.styles)
        require(
            draft.body.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES &&
                (html == null || html.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES)
        ) {
            "正文超过 2 MB，请精简后发送"
        }
        fun bodyPart() =
            MimeBodyPart().apply {
                if (html == null) setText(draft.body, "UTF-8")
                else {
                    val alternative = MimeMultipart("alternative")
                    alternative.addBodyPart(MimeBodyPart().apply { setText(draft.body, "UTF-8") })
                    alternative.addBodyPart(
                        MimeBodyPart().apply { setContent(html, "text/html; charset=UTF-8") }
                    )
                    setContent(alternative)
                }
            }
        return object : MimeMessage(session) {
                override fun updateMessageID() {
                    setHeader("Message-ID", draft.messageId)
                }
            }
            .apply {
                setFrom(
                    InternetAddress(account.email, account.name.ifBlank { account.email }, "UTF-8")
                )
                targets.forEach { (type, recipients) ->
                    if (recipients.isNotEmpty()) setRecipients(type, recipients)
                }
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
                if (draft.attachments.isEmpty()) {
                    if (html == null) setText(draft.body, "UTF-8")
                    else {
                        val body = bodyPart()
                        setContent(body.content, body.contentType)
                    }
                } else {
                    val mixed = MimeMultipart("mixed")
                    mixed.addBodyPart(bodyPart())
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
