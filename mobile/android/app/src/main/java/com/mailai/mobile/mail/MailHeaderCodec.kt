package com.mailai.mobile.mail

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.Base64
import javax.mail.internet.MimeUtility

/** Decode bytes strictly before JavaMail can replace a mislabeled Chinese character. */
internal object MailHeaderCodec {
    private val word = Regex("=\\?([^? \\t\\r\\n]+)\\?([bBqQ])\\?([^?\\r\\n]*)\\?=")

    fun decodeBytes(value: ByteArray, declared: String): String {
        val encodings =
            listOf(MimeUtility.javaCharset(declared), "UTF-8", "GB18030", "Big5", "windows-1252")
        for (encoding in encodings.distinct()) {
            val result =
                runCatching {
                        Charset.forName(encoding)
                            .newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(value))
                            .toString()
                    }
                    .getOrNull()
            if (result != null) return result
        }
        return value.toString(Charsets.UTF_8)
    }

    private fun decodeWord(match: MatchResult): String =
        runCatching {
                val payload = match.groupValues[3]
                val decoded =
                    if (match.groupValues[2].equals("B", true)) {
                        Base64.getDecoder().decode(payload)
                    } else {
                        val out = java.io.ByteArrayOutputStream()
                        var index = 0
                        while (index < payload.length) {
                            when (val c = payload[index++]) {
                                '_' -> out.write(' '.code)
                                '=' -> {
                                    require(index + 2 <= payload.length)
                                    out.write(payload.substring(index, index + 2).toInt(16))
                                    index += 2
                                }
                                else -> {
                                    require(c.code < 128)
                                    out.write(c.code)
                                }
                            }
                        }
                        out.toByteArray()
                    }
                if (decoded.isEmpty()) match.value else decodeBytes(decoded, match.groupValues[1])
            }
            .getOrDefault(match.value)

    fun decode(value: String): String {
        val raw = value.replace(Regex("\\r?\\n[ \\t]+"), " ")
        return buildString {
            var end = 0
            for (match in word.findAll(raw)) {
                val gap = raw.substring(end, match.range.first)
                if (end == 0 || gap.any { !it.isWhitespace() }) append(gap)
                append(decodeWord(match))
                end = match.range.last + 1
            }
            append(raw.substring(end))
        }
    }

    /** Keep encoded punctuation inside the name while the address parser splits recipients. */
    fun normalizeWords(value: String): String =
        word.replace(value) { match ->
            val decoded = decodeWord(match)
            if (decoded == match.value) match.value
            else MimeUtility.encodeWord(decoded, "UTF-8", "B")
        }

    fun damaged(value: String): Boolean =
        value.codePoints().anyMatch { it == 0xfffd || it in 0xd800..0xdfff }
}
