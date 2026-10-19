package com.mailai.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

internal enum class MailGlyph {
    Back,
    Chevron,
    Expand,
    Search,
    Clear,
    Star,
    More,
    Inbox,
    Mail,
    Attachment,
    Draft,
    Send,
    Trash,
    Archive,
    Contacts,
    Bell,
    Refresh,
    Pen,
    Settings,
    Moon,
    Font,
    Shield,
    Download,
    Reply,
    ReplyAll,
    Forward,
    Check,
    Info,
    Wifi,
    Folder,
}

/** A single, restrained stroke family. Labels belong to the surrounding button. */
@Composable
internal fun MailIcon(
    glyph: MailGlyph,
    description: String? = null,
    modifier: Modifier = Modifier.size(22.dp),
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Canvas(modifier.semantics { if (description != null) contentDescription = description }) {
        val factor = minOf(size.width, size.height) / 24f
        withTransform({
            translate((size.width - 24f * factor) / 2f, (size.height - 24f * factor) / 2f)
            scale(factor, factor, androidx.compose.ui.geometry.Offset.Zero)
        }) {
            fun path(vararg points: Pair<Float, Float>) {
                val p = Path()
                points.forEachIndexed { i, (x, y) ->
                    if (i == 0) p.moveTo(x, y) else p.lineTo(x, y)
                }
                drawPath(
                    p,
                    tint,
                    style = Stroke(1.7f, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }
            fun line(x: Int, y: Int, a: Int, b: Int) =
                path(x.toFloat() to y.toFloat(), a.toFloat() to b.toFloat())
            fun circle(x: Float, y: Float, r: Float) =
                drawCircle(tint, r, androidx.compose.ui.geometry.Offset(x, y), style = Stroke(1.7f))
            when (glyph) {
                MailGlyph.Back -> path(15f to 4f, 7f to 12f, 15f to 20f)
                MailGlyph.Chevron -> path(9f to 5f, 16f to 12f, 9f to 19f)
                MailGlyph.Expand -> path(6f to 9f, 12f to 15f, 18f to 9f)
                MailGlyph.Search -> {
                    circle(10.5f, 10.5f, 6.5f)
                    line(16, 16, 21, 21)
                }
                MailGlyph.Clear -> {
                    line(7, 7, 17, 17)
                    line(17, 7, 7, 17)
                }
                MailGlyph.Check -> path(5f to 12f, 10f to 17f, 19f to 7f)
                MailGlyph.More ->
                    listOf(5f, 12f, 19f).forEach {
                        drawCircle(tint, 1.5f, androidx.compose.ui.geometry.Offset(it, 12f))
                    }
                MailGlyph.Star ->
                    path(
                        12f to 3f,
                        14.8f to 8.8f,
                        21f to 9.8f,
                        16.5f to 14.3f,
                        17.6f to 21f,
                        12f to 18f,
                        6.4f to 21f,
                        7.5f to 14.3f,
                        3f to 9.8f,
                        9.2f to 8.8f,
                        12f to 3f,
                    )
                MailGlyph.Mail -> {
                    path(
                        3f to 5f,
                        21f to 5f,
                        21f to 19f,
                        3f to 19f,
                        3f to 5f,
                        12f to 12f,
                        21f to 5f,
                    )
                }
                MailGlyph.Inbox -> {
                    path(
                        3f to 13f,
                        6f to 5f,
                        18f to 5f,
                        21f to 13f,
                        21f to 20f,
                        3f to 20f,
                        3f to 13f,
                        8f to 13f,
                        10f to 16f,
                        14f to 16f,
                        16f to 13f,
                        21f to 13f,
                    )
                }
                MailGlyph.Attachment -> {
                    val p = Path()
                    p.moveTo(8f, 13f)
                    p.lineTo(15f, 6f)
                    p.cubicTo(20f, 1f, 25f, 8f, 20f, 13f)
                    p.lineTo(11f, 22f)
                    p.cubicTo(6f, 27f, -1f, 19f, 4f, 14f)
                    p.lineTo(13f, 5f)
                    drawPath(p, tint, style = Stroke(1.7f, cap = StrokeCap.Round))
                }
                MailGlyph.Draft -> {
                    path(5f to 3f, 14f to 3f, 20f to 9f, 20f to 21f, 5f to 21f, 5f to 3f)
                    path(14f to 3f, 14f to 9f, 20f to 9f)
                    line(9, 13, 16, 13)
                    line(9, 17, 15, 17)
                }
                MailGlyph.Send -> {
                    path(3f to 10f, 21f to 3f, 14f to 21f, 10f to 14f, 3f to 10f)
                    line(10, 14, 21, 3)
                }
                MailGlyph.Trash -> {
                    line(3, 6, 21, 6)
                    path(6f to 6f, 7f to 21f, 17f to 21f, 18f to 6f)
                    path(9f to 6f, 9f to 3f, 15f to 3f, 15f to 6f)
                    line(10, 10, 10, 17)
                    line(14, 10, 14, 17)
                }
                MailGlyph.Archive -> {
                    path(3f to 4f, 21f to 4f, 21f to 9f, 3f to 9f, 3f to 4f)
                    path(5f to 9f, 5f to 21f, 19f to 21f, 19f to 9f)
                    line(10, 13, 14, 13)
                }
                MailGlyph.Contacts -> {
                    circle(10f, 7f, 3.5f)
                    val p = Path()
                    p.moveTo(3f, 21f)
                    p.cubicTo(3f, 12f, 17f, 12f, 17f, 21f)
                    drawPath(p, tint, style = Stroke(1.7f, cap = StrokeCap.Round))
                    line(20, 11, 20, 17)
                    line(17, 14, 23, 14)
                }
                MailGlyph.Bell -> {
                    val p = Path()
                    p.moveTo(4f, 18f)
                    p.lineTo(6f, 15f)
                    p.lineTo(6f, 9f)
                    p.cubicTo(6f, 1f, 18f, 1f, 18f, 9f)
                    p.lineTo(18f, 15f)
                    p.lineTo(20f, 18f)
                    p.close()
                    drawPath(p, tint, style = Stroke(1.7f, join = StrokeJoin.Round))
                    path(10f to 21f, 14f to 21f)
                }
                MailGlyph.Refresh -> {
                    val p = Path()
                    p.moveTo(20f, 9f)
                    p.cubicTo(16f, -2f, 1f, 3f, 4f, 15f)
                    p.cubicTo(7f, 24f, 20f, 23f, 21f, 14f)
                    drawPath(p, tint, style = Stroke(1.7f, cap = StrokeCap.Round))
                    path(20f to 3f, 20f to 9f, 14f to 9f)
                }
                MailGlyph.Pen -> {
                    path(4f to 17f, 16f to 5f, 20f to 9f, 8f to 21f, 3f to 22f, 4f to 17f)
                    line(13, 8, 17, 12)
                }
                MailGlyph.Settings -> {
                    listOf(6, 12, 18).forEach { y -> line(3, y, 21, y) }
                    circle(8f, 6f, 2f)
                    circle(16f, 12f, 2f)
                    circle(10f, 18f, 2f)
                }
                MailGlyph.Moon -> {
                    val p = Path()
                    p.moveTo(20f, 15f)
                    p.cubicTo(10f, 20f, 3f, 9f, 10f, 3f)
                    p.cubicTo(-3f, 6f, 2f, 25f, 15f, 21f)
                    p.cubicTo(18f, 20f, 20f, 18f, 20f, 15f)
                    drawPath(p, tint, style = Stroke(1.7f))
                }
                MailGlyph.Font -> {
                    path(2f to 20f, 8f to 4f, 14f to 20f)
                    line(5, 14, 11, 14)
                    path(17f to 11f, 21f to 11f, 21f to 20f)
                    line(17, 16, 21, 16)
                    line(17, 20, 21, 20)
                }
                MailGlyph.Shield -> {
                    path(
                        12f to 3f,
                        21f to 7f,
                        20f to 15f,
                        17f to 19f,
                        12f to 22f,
                        7f to 19f,
                        4f to 15f,
                        3f to 7f,
                        12f to 3f,
                    )
                    path(8f to 12f, 11f to 15f, 16f to 9f)
                }
                MailGlyph.Download -> {
                    path(12f to 3f, 12f to 16f)
                    path(6f to 10f, 12f to 16f, 18f to 10f)
                    path(4f to 18f, 4f to 21f, 20f to 21f, 20f to 18f)
                }
                MailGlyph.Reply,
                MailGlyph.ReplyAll,
                MailGlyph.Forward -> {
                    if (glyph == MailGlyph.Forward) {
                        path(14f to 4f, 21f to 10f, 14f to 16f, 14f to 12f)
                        path(
                            14f to 12f,
                            8f to 12f,
                            3f to 20f,
                            4f to 10f,
                            8f to 7f,
                            14f to 7f,
                            14f to 4f,
                        )
                    } else {
                        path(10f to 4f, 3f to 10f, 10f to 16f, 10f to 12f)
                        path(
                            10f to 12f,
                            16f to 12f,
                            21f to 20f,
                            20f to 10f,
                            16f to 7f,
                            10f to 7f,
                            10f to 4f,
                        )
                        if (glyph == MailGlyph.ReplyAll) path(6f to 3f, 0f to 9f, 6f to 15f)
                    }
                }
                MailGlyph.Info -> {
                    circle(12f, 12f, 9f)
                    line(12, 11, 12, 17)
                    drawCircle(tint, 1f, androidx.compose.ui.geometry.Offset(12f, 7f))
                }
                MailGlyph.Wifi -> {
                    path(2f to 8f, 6f to 5f, 12f to 4f, 18f to 5f, 22f to 8f)
                    path(6f to 12f, 9f to 10f, 15f to 10f, 18f to 12f)
                    path(9f to 16f, 12f to 14f, 15f to 16f)
                    drawCircle(tint, 1f, androidx.compose.ui.geometry.Offset(12f, 20f))
                }
                MailGlyph.Folder ->
                    path(3f to 6f, 10f to 6f, 12f to 8f, 21f to 8f, 21f to 20f, 3f to 20f, 3f to 6f)
            }
        }
    }
}
