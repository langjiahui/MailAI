package com.mailai.mobile.ui

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.data.*

private data class BodySnapshot(
    val body: String,
    val styles: List<BodyStyle>,
    val selection: TextRange,
)

// Preview chosen colors legibly on dark paper; the outgoing color value stays unchanged.
private fun editorColor(value: String, dark: Boolean): Color =
    when {
        dark && value == "#122338" -> Color(0xFFEAF0F7)
        dark && value == "#176648" -> Color(0xFF9CDBBC)
        dark && value == "#A33F35" -> Color(0xFFFFB4A9)
        else -> Color(android.graphics.Color.parseColor(value))
    }

/** Compose text editing retains Android selection/copy/paste and IME composing ranges. */
@Composable
internal fun RichComposeBody(
    draft: Draft,
    editable: Boolean,
    height: Dp,
    focus: FocusRequester,
    focused: (Boolean) -> Unit,
    change: (Draft) -> Unit,
    notice: (String) -> Unit,
    leadingControls: (@Composable () -> Unit)? = null,
    trailingControls: (@Composable () -> Unit)? = null,
) {
    val dark = MaterialTheme.colorScheme.background.luminance() < .5f
    val glyphScale = LocalDensity.current.fontScale
    var savedStart by rememberSaveable(draft.id) { mutableIntStateOf(0) }
    var savedEnd by rememberSaveable(draft.id) { mutableIntStateOf(0) }
    var editor by
        remember(draft.id) {
            mutableStateOf(
                TextFieldValue(
                    draft.body,
                    TextRange(
                        savedStart.coerceIn(0, draft.body.length),
                        savedEnd.coerceIn(0, draft.body.length),
                    ),
                )
            )
        }
    SideEffect {
        savedStart = editor.selection.start
        savedEnd = editor.selection.end
    }
    val undo = remember(draft.id) { mutableStateListOf<BodySnapshot>() }
    val redo = remember(draft.id) { mutableStateListOf<BodySnapshot>() }
    var pending by remember(draft.id) { mutableStateOf<Map<BodyStyleKind, String?>>(emptyMap()) }
    var lastTyping by remember(draft.id) { mutableLongStateOf(0L) }
    var sizeMenu by remember { mutableStateOf(false) }
    var colorMenu by remember { mutableStateOf(false) }
    var linkDialog by remember { mutableStateOf(false) }
    var linkText by remember { mutableStateOf("") }
    var linkUrl by remember { mutableStateOf("") }
    var linkError by remember { mutableStateOf("") }
    val selection =
        TextRange(
            editor.selection.start.coerceIn(0, draft.body.length),
            editor.selection.end.coerceIn(0, draft.body.length),
        )
    fun snapshot() = BodySnapshot(draft.body, draft.styles, selection)
    fun rememberUndo() {
        undo.add(snapshot())
        while (
            undo.size > 30 || (undo.size > 1 && undo.sumOf { it.body.length.toLong() } > 200_000)
        ) undo.removeAt(0)
        redo.clear()
    }
    fun restore(s: BodySnapshot) {
        editor = TextFieldValue(s.body, s.selection)
        pending = emptyMap()
        lastTyping = 0
        change(draft.copy(body = s.body, styles = s.styles))
    }
    fun active(kind: BodyStyleKind): String? {
        if (selection.collapsed && pending.containsKey(kind)) return pending[kind]
        return draft.styles
            .lastOrNull {
                it.kind == kind &&
                    it.start <= selection.min &&
                    it.end >= selection.max &&
                    (selection.collapsed || it.start < selection.max)
            }
            ?.value
    }
    fun format(kind: BodyStyleKind, value: String = "") {
        if (!editable) return
        if (selection.collapsed)
            pending = pending + (kind to if (active(kind) == value) null else value)
        else {
            try {
                val styles =
                    RichBody.apply(
                        draft.body,
                        draft.styles,
                        selection.min,
                        selection.max,
                        kind,
                        value,
                    )
                rememberUndo()
                change(draft.copy(styles = styles))
                lastTyping = 0
            } catch (e: IllegalArgumentException) {
                notice(e.message.orEmpty())
            }
        }
    }
    val styled =
        remember(draft.body, draft.styles, dark) {
            buildAnnotatedString {
                append(draft.body)
                draft.styles
                    .filter { RichBody.valid(it, draft.body.length) }
                    .forEach { s ->
                        addStyle(
                            when (s.kind) {
                                BodyStyleKind.BOLD -> SpanStyle(fontWeight = FontWeight.Bold)
                                BodyStyleKind.ITALIC -> SpanStyle(fontStyle = FontStyle.Italic)
                                BodyStyleKind.UNDERLINE ->
                                    SpanStyle(textDecoration = TextDecoration.Underline)
                                BodyStyleKind.SIZE -> SpanStyle(fontSize = s.value.toInt().sp)
                                BodyStyleKind.COLOR -> SpanStyle(color = editorColor(s.value, dark))
                                BodyStyleKind.LINK ->
                                    SpanStyle(
                                        color = editorColor("#176648", dark),
                                        textDecoration = TextDecoration.Underline,
                                    )
                            },
                            s.start,
                            s.end,
                        )
                    }
            }
        }
    val display =
        TextFieldValue(
            styled,
            selection,
            if (editor.text == draft.body) editor.composition else null,
        )
    Column {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            leadingControls?.invoke()
            Row(
                Modifier.weight(1f)
                    .background(composerFieldColor().copy(alpha = .65f), RoundedCornerShape(14.dp))
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 4.dp)
                    .testTag("compose-formatting"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = {
                        redo.add(snapshot())
                        restore(undo.removeAt(undo.lastIndex))
                    },
                    enabled = editable && undo.isNotEmpty(),
                    modifier = Modifier.semantics { contentDescription = "撤销" },
                ) {
                    Text("↶", fontSize = (24f / glyphScale).sp, lineHeight = (28f / glyphScale).sp)
                }
                IconButton(
                    onClick = {
                        undo.add(snapshot())
                        restore(redo.removeAt(redo.lastIndex))
                    },
                    enabled = editable && redo.isNotEmpty(),
                    modifier = Modifier.semantics { contentDescription = "重做" },
                ) {
                    Text("↷", fontSize = (24f / glyphScale).sp, lineHeight = (28f / glyphScale).sp)
                }
                Box {
                    TextButton(
                        onClick = { sizeMenu = true },
                        enabled = editable,
                        modifier = Modifier.semantics { contentDescription = "字号" },
                    ) {
                        Text("${active(BodyStyleKind.SIZE) ?: "16"}⌄")
                    }
                    DropdownMenu(sizeMenu, { sizeMenu = false }) {
                        listOf("14", "16", "18", "20").forEach { size ->
                            DropdownMenuItem(
                                text = { Text("$size 号") },
                                onClick = {
                                    format(BodyStyleKind.SIZE, size)
                                    sizeMenu = false
                                },
                            )
                        }
                    }
                }
                listOf(
                        Triple(BodyStyleKind.BOLD, "B", "加粗"),
                        Triple(BodyStyleKind.ITALIC, "I", "斜体"),
                        Triple(BodyStyleKind.UNDERLINE, "U", "下划线"),
                    )
                    .forEach { (kind, label, description) ->
                        IconToggleButton(
                            checked = active(kind) != null,
                            onCheckedChange = { format(kind) },
                            enabled = editable,
                            modifier = Modifier.semantics { contentDescription = description },
                        ) {
                            Text(
                                label,
                                fontSize = (20f / glyphScale).sp,
                                lineHeight = (24f / glyphScale).sp,
                                fontWeight =
                                    if (kind == BodyStyleKind.BOLD) FontWeight.Bold
                                    else FontWeight.Normal,
                                fontStyle =
                                    if (kind == BodyStyleKind.ITALIC) FontStyle.Italic
                                    else FontStyle.Normal,
                                textDecoration =
                                    if (kind == BodyStyleKind.UNDERLINE) TextDecoration.Underline
                                    else null,
                            )
                        }
                    }
                Box {
                    TextButton(
                        onClick = { colorMenu = true },
                        enabled = editable,
                        modifier = Modifier.semantics { contentDescription = "文字颜色" },
                    ) {
                        Text(
                            "A⌄",
                            color =
                                active(BodyStyleKind.COLOR)?.let { editorColor(it, dark) }
                                    ?: MaterialTheme.colorScheme.primary,
                        )
                    }
                    DropdownMenu(colorMenu, { colorMenu = false }) {
                        RichBody.colors.zip(listOf("森林绿", "墨黑", "砖红")).forEach { (color, label) ->
                            DropdownMenuItem(
                                text = { Text(label, color = editorColor(color, dark)) },
                                onClick = {
                                    format(BodyStyleKind.COLOR, color)
                                    colorMenu = false
                                },
                            )
                        }
                    }
                }
                TextButton(
                    onClick = {
                        linkText = draft.body.substring(selection.min, selection.max)
                        linkUrl = "https://"
                        linkError = ""
                        linkDialog = true
                    },
                    enabled = editable,
                ) {
                    Text("链接")
                }
                TextButton(
                    onClick = {
                        if (selection.collapsed) {
                            pending = BodyStyleKind.entries.associateWith { null }
                            notice("后续输入使用默认格式")
                        } else {
                            rememberUndo()
                            var styles = draft.styles
                            BodyStyleKind.entries.forEach {
                                styles =
                                    RichBody.clear(
                                        draft.body,
                                        styles,
                                        selection.min,
                                        selection.max,
                                        it,
                                    )
                            }
                            change(draft.copy(styles = styles))
                        }
                    },
                    enabled = editable,
                ) {
                    Text("清除格式")
                }
            }
            trailingControls?.invoke()
        }
        TextField(
            value = display,
            onValueChange = { next ->
                if (next.text != draft.body) {
                    val now = SystemClock.uptimeMillis()
                    if (now - lastTyping > 900 || lastTyping == 0L) rememberUndo()
                    var styles = RichBody.edit(draft.body, next.text, draft.styles)
                    val start = draft.body.commonPrefixWith(next.text).length
                    val suffix =
                        draft.body
                            .substring(start)
                            .commonSuffixWith(next.text.substring(start))
                            .length
                    val end = next.text.length - suffix
                    if (end > start)
                        pending.forEach { (kind, value) ->
                            try {
                                styles =
                                    if (value == null)
                                        RichBody.clear(next.text, styles, start, end, kind)
                                    else
                                        RichBody.apply(
                                            next.text,
                                            styles,
                                            start,
                                            end,
                                            kind,
                                            value,
                                            false,
                                        )
                            } catch (_: IllegalArgumentException) {
                                notice("格式数量达到上限，正文已保留")
                            }
                        }
                    editor = next
                    lastTyping = now
                    redo.clear()
                    change(draft.copy(body = next.text, styles = styles))
                } else {
                    if (next.selection != selection) {
                        pending = emptyMap()
                        lastTyping = 0
                    }
                    editor = next
                }
            },
            placeholder = { Text("请输入邮件正文…") },
            readOnly = !editable,
            textStyle = LocalTextStyle.current.copy(fontSize = 16.sp, lineHeight = 27.sp),
            modifier =
                Modifier.fillMaxWidth()
                    .height(height)
                    .focusRequester(focus)
                    .onFocusChanged { focused(it.isFocused) }
                    .testTag("compose-body"),
            colors =
                TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
        )
    }
    if (linkDialog)
        AlertDialog(
            onDismissRequest = { linkDialog = false },
            title = { Text("插入链接") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        linkText,
                        { linkText = it },
                        label = { Text("显示文字") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        linkUrl,
                        {
                            linkUrl = it
                            linkError = ""
                        },
                        label = { Text("HTTPS 链接") },
                        singleLine = true,
                        isError = linkError.isNotEmpty(),
                    )
                    if (linkError.isNotEmpty())
                        Text(linkError, color = MaterialTheme.colorScheme.error)
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (!RichBody.safeLink(linkUrl.trim())) linkError = "请填写有效的 HTTPS 链接"
                        else {
                            val insert = linkText.ifBlank { linkUrl.trim() }
                            val text = draft.body.replaceRange(selection.min, selection.max, insert)
                            try {
                                val styles =
                                    RichBody.apply(
                                        text,
                                        RichBody.edit(draft.body, text, draft.styles),
                                        selection.min,
                                        selection.min + insert.length,
                                        BodyStyleKind.LINK,
                                        linkUrl.trim(),
                                        false,
                                    )
                                rememberUndo()
                                editor =
                                    TextFieldValue(text, TextRange(selection.min + insert.length))
                                change(draft.copy(body = text, styles = styles))
                                linkDialog = false
                            } catch (_: IllegalArgumentException) {
                                linkError = "格式数量达到上限，请先清除部分格式"
                            }
                        }
                    },
                    enabled = editable,
                ) {
                    Text("插入")
                }
            },
            dismissButton = { TextButton(onClick = { linkDialog = false }) { Text("取消") } },
        )
}
