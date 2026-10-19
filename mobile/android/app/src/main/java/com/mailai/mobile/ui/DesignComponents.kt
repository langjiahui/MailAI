package com.mailai.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.R

@Composable
internal fun MailCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .65f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = .07f)),
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
internal fun ContactAvatar(name: String) {
    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Text(
                name.trim().take(1).uppercase().ifBlank { "邮" },
                fontSize = 18.sp,
                lineHeight = 20.sp,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
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
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp)
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
        Text("›", fontSize = 24.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun FileLabel(name: String, size: Long, modifier: Modifier = Modifier) {
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.primaryContainer,
        ) {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                Text(
                    name.substringAfterLast('.', "FILE").uppercase().take(4),
                    fontSize = 10.sp,
                    lineHeight = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
        Column(Modifier.weight(1f)) {
            Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
            Text(
                if (size < 0) "大小未知" else if (size < 1024) "$size B" else "${size / 1024} KB",
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
    BoxWithConstraints {
        val stacked =
            maxWidth < 320.dp || androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.3f
        Column(
            Modifier.fillMaxWidth()
                .clickable(enabled = enabled, onClick = choose)
                .padding(start = 16.dp, end = if (stacked) 16.dp else 0.dp)
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                ContactAvatar(account.name.ifBlank { account.email })
                Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 16.dp)) {
                    Text(
                        account.name.ifBlank { account.email.substringBefore('@') },
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        account.email,
                        Modifier.padding(top = 3.dp),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (current)
                        Text(
                            "当前邮箱",
                            Modifier.padding(top = 4.dp),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.primary,
                        )
                }
                if (!stacked)
                    TextButton(onClick = edit, enabled = enabled) { Text("登录设置", fontSize = 12.sp) }
            }
            if (stacked)
                TextButton(
                    onClick = edit,
                    enabled = enabled,
                    modifier = Modifier.align(Alignment.End),
                ) {
                    Text("登录设置", fontSize = 12.sp)
                }
        }
    }
}
