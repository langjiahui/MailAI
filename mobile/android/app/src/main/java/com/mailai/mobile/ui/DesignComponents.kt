package com.mailai.mobile.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.R
import java.util.Locale

@Composable
internal fun MailCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(content = content)
    }
}

@Composable
internal fun Brand() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Image(painterResource(R.drawable.mailai_brand), null, Modifier.size(38.dp))
        Text("MailAI", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun ContactAvatar(name: String, size: androidx.compose.ui.unit.Dp = 40.dp) {
    val palette = listOf(Color(0xFF4288F5), Color(0xFF8A67DF), Color(0xFFF3A13B), Color(0xFF329675))
    val label = name.trim().trim('"', '\'').ifBlank { "邮" }
    val color = palette[(label.lowercase(Locale.ROOT).hashCode() and Int.MAX_VALUE) % palette.size]
    val scale = LocalDensity.current.fontScale
    val initialSize = (size.value * .44f * minOf(scale, 1.25f) / scale).sp
    Surface(shape = CircleShape, color = color) {
        Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Text(
                String(Character.toChars(label.codePointAt(0))).uppercase(Locale.ROOT),
                fontSize = initialSize,
                lineHeight = initialSize * 1.15f,
                maxLines = 1,
                color = Color.White,
            )
        }
    }
}

@Composable
internal fun SectionCaption(text: String) {
    Text(
        text,
        Modifier.padding(top = 20.dp, bottom = 8.dp, start = 2.dp),
        fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun MenuRow(
    title: String,
    detail: String = "",
    count: String = "",
    enabled: Boolean = true,
    icon: MailGlyph? = null,
    selected: Boolean = false,
    onClick: () -> Unit,
) {
    Surface(
        color =
            if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .55f)
            else Color.Transparent,
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(enabled = enabled, onClick = onClick)
                .heightIn(min = 56.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (icon != null)
                MailIcon(
                    icon,
                    tint =
                        if (selected) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                if (detail.isNotBlank())
                    Text(
                        detail,
                        Modifier.padding(top = 3.dp),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
            }
            if (count.isNotBlank())
                Text(count, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            MailIcon(MailGlyph.Chevron, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
internal fun FileLabel(name: String, size: Long, modifier: Modifier = Modifier) {
    val extension = name.substringAfterLast('.', "FILE").uppercase().take(4)
    val dark = MaterialTheme.colorScheme.surface.luminance() < .5f
    val scale = LocalDensity.current.fontScale
    val badge =
        when (extension) {
            "PDF" -> if (dark) Color(0xFFFF9C9C) else Color(0xFFB83333)
            "XLS",
            "XLSX",
            "CSV" -> if (dark) Color(0xFF83DAB1) else Color(0xFF176947)
            "DOC",
            "DOCX" -> if (dark) Color(0xFF9CC8FF) else Color(0xFF2463A5)
            else -> MaterialTheme.colorScheme.primary
        }
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(shape = RoundedCornerShape(8.dp), color = badge.copy(alpha = .12f)) {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                Text(
                    extension,
                    fontSize = (10f / scale).sp,
                    lineHeight = (12f / scale).sp,
                    maxLines = 1,
                    fontWeight = FontWeight.Medium,
                    color = badge,
                )
            }
        }
        Column(Modifier.weight(1f)) {
            Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
            Text(
                fileSize(size),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
internal fun AccountRow(
    account: com.mailai.mobile.data.Account,
    current: Boolean,
    enabled: Boolean,
    choose: () -> Unit,
    edit: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(enabled = enabled, onClick = choose)
            .padding(start = 16.dp, end = 4.dp, top = 16.dp, bottom = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ContactAvatar(account.name.ifBlank { account.email }, 44.dp)
        Column(Modifier.weight(1f)) {
            Text(
                account.email,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                account.name.ifBlank { if (current) "当前邮箱" else "切换邮箱" },
                Modifier.padding(top = 4.dp),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = edit, enabled = enabled) {
            MailIcon(MailGlyph.Chevron, "登录设置", Modifier.size(18.dp))
        }
    }
}

internal fun fileSize(size: Long): String =
    when {
        size < 0 -> "大小未知"
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> "${size / 1024} KB"
        else -> java.lang.String.format(java.util.Locale.getDefault(), "%.1f MB", size / 1048576.0)
    }

@Composable
internal fun PageHeader(
    title: String,
    back: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 4.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = back) {
            MailIcon(MailGlyph.Back, "返回", tint = MaterialTheme.colorScheme.onSurface)
        }
        Text(
            title,
            Modifier.weight(1f).padding(start = 4.dp, end = 8.dp),
            fontSize = 18.sp,
            lineHeight = 24.sp,
            fontWeight = FontWeight.SemiBold,
        )
        actions()
    }
}

@Composable
internal fun SearchInput(
    value: String,
    change: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
    cancel: (() -> Unit)? = null,
    submit: (() -> Unit)? = null,
) {
    TextField(
        value = value,
        onValueChange = change,
        placeholder = {
            Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
        },
        leadingIcon = { MailIcon(MailGlyph.Search) },
        trailingIcon = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (value.isNotEmpty())
                    IconButton(onClick = { change("") }) { MailIcon(MailGlyph.Clear, "清除") }
                if (cancel != null) TextButton(onClick = cancel) { Text("取消") }
            }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions =
            KeyboardActions(
                onSearch = {
                    if (submit != null) submit() else defaultKeyboardAction(ImeAction.Done)
                }
            ),
        shape = RoundedCornerShape(28.dp),
        modifier = modifier.fillMaxWidth(),
        colors =
            TextFieldDefaults.colors(
                focusedContainerColor = MaterialTheme.colorScheme.surface,
                unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
            ),
    )
}
