package com.mailai.mobile.mail

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.pdf.PdfDocument
import android.text.Html
import android.text.StaticLayout
import android.text.TextPaint
import android.util.Base64
import java.io.File
import org.jsoup.Jsoup
import org.jsoup.nodes.Entities

/** Render a shareable attachment from the current snapshot, independent of Android Print. */
internal fun createMailPdf(context: Context, document: MailOutput.Document): File {
    val pageWidth = 595
    val pageHeight = 842
    val margin = 45
    val width = pageWidth - 2 * margin
    val height = pageHeight - 2 * margin
    val body = Jsoup.parse(document.html).body()
    body.select("[style], [color], [bgcolor]").forEach {
        it.removeAttr("style").removeAttr("color").removeAttr("bgcolor")
    }
    body.select("tr").forEach { row ->
        row.appendElement("td").appendElement("br")
        row.select("td, th").dropLast(1).forEach { it.append("&nbsp;&nbsp; ") }
    }
    body.select("pre").forEach { block ->
        block.tagName("p").html(Entities.escape(block.wholeText()).replace("\n", "<br>"))
    }
    var decodedPixels = 0L
    val imageGetter =
        Html.ImageGetter { source ->
            val encoded = source.substringAfter(";base64,", "")
            if (!source.startsWith("data:image/", ignoreCase = true) || encoded.isEmpty()) {
                return@ImageGetter null
            }
            val bytes =
                runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull()
                    ?: return@ImageGetter null
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            if (options.outWidth <= 0 || options.outHeight <= 0) return@ImageGetter null
            options.inSampleSize = 1
            while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 1024) {
                options.inSampleSize *= 2
            }
            val pixels =
                (options.outWidth.toLong() / options.inSampleSize) *
                    (options.outHeight.toLong() / options.inSampleSize)
            if (decodedPixels + pixels > 8_000_000) return@ImageGetter null
            decodedPixels += pixels
            options.inJustDecodeBounds = false
            val bitmap =
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                    ?: return@ImageGetter null
            val scale = minOf(1f, width.toFloat() / bitmap.width, 360f / bitmap.height)
            BitmapDrawable(context.resources, bitmap).apply {
                setBounds(
                    0,
                    0,
                    (bitmap.width * scale).toInt().coerceAtLeast(1),
                    (bitmap.height * scale).toInt().coerceAtLeast(1),
                )
            }
        }
    val text = Html.fromHtml(body.html(), Html.FROM_HTML_MODE_COMPACT, imageGetter, null)
    val paint =
        TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(32, 40, 36)
            textSize = 12f
        }
    val layout =
        StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
            .setLineSpacing(3f, 1f)
            .build()
    val directory = File(context.cacheDir, "mail-output").apply { mkdirs() }
    val cutoff = System.currentTimeMillis() - 7L * 86400000
    directory.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    val target = File.createTempFile("mail-", ".pdf", directory)
    val pdf = PdfDocument()
    try {
        var first = 0
        var number = 1
        while (first < layout.lineCount) {
            val top = layout.getLineTop(first)
            var last = first
            while (last + 1 < layout.lineCount && layout.getLineBottom(last + 1) - top <= height) {
                last++
            }
            require(number <= 500) { "邮件过长，无法生成 PDF" }
            val page =
                pdf.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, number).create())
            page.canvas.apply {
                save()
                clipRect(
                    margin,
                    margin,
                    pageWidth - margin,
                    margin + minOf(height, layout.getLineBottom(last) - top),
                )
                translate(margin.toFloat(), (margin - top).toFloat())
                layout.draw(this)
                restore()
            }
            pdf.finishPage(page)
            first = last + 1
            number++
        }
        target.outputStream().use { pdf.writeTo(it) }
        return target
    } catch (failure: Exception) {
        target.delete()
        throw failure
    } finally {
        pdf.close()
    }
}
