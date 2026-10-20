package com.mailai.mobile.ui

import android.content.ClipData
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun peopleSummary(mail: MailItem, ownEmail: String): String {
    val people =
        (MailAddresses.parse(mail.recipients) + MailAddresses.parse(mail.cc)).distinctBy {
            it.email.lowercase()
        }
    val me = people.any { it.email.equals(ownEmail, true) }
    val first = if (me) "我" else people.firstOrNull()?.label ?: "收件人"
    return if (people.size > 1) "发给$first · 共 ${people.size} 人" else "发给$first"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MailPeopleDialog(vm: MailViewModel, mail: MailItem, close: () -> Unit) {
    val groups =
        remember(mail.sender, mail.recipients, mail.cc) {
            listOf(
                    "发件人" to MailAddresses.parse(mail.sender),
                    "收件人" to MailAddresses.parse(mail.recipients),
                    "抄送" to MailAddresses.parse(mail.cc),
                )
                .filter { it.second.isNotEmpty() }
        }
    val listState = rememberLazyListState()
    var expandedKey by remember(mail.key) { mutableStateOf<String?>(null) }
    MailBottomSheet(title = "邮件详情", onDismiss = close) {
        Column(Modifier.fillMaxWidth().testTag("mail-details-sheet")) {
            TextButton(
                onClick = { vm.toggleStar(mail) },
                enabled = !vm.busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (mail.key in vm.stars) "取消星标" else "添加星标")
            }
            Box(Modifier.weight(1f, fill = false)) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxWidth().testTag("mail-details-list"),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    item(key = "subject") {
                        Column(Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) {
                            Text(
                                "主题",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            SelectionContainer {
                                Text(
                                    mail.subject,
                                    Modifier.padding(top = 6.dp),
                                    fontSize = 16.sp,
                                    lineHeight = 24.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                            if (mail.date > 0)
                                Text(
                                    SimpleDateFormat("yyyy年M月d日 HH:mm", Locale.getDefault())
                                        .format(Date(mail.date)),
                                    Modifier.padding(top = 8.dp),
                                    fontSize = 12.sp,
                                    lineHeight = 18.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                        }
                        HorizontalDivider(
                            Modifier.padding(horizontal = 20.dp),
                            color = MaterialTheme.colorScheme.outlineVariant,
                        )
                    }
                    groups.forEach { (label, people) ->
                        item(key = "group-$label") {
                            Row(
                                Modifier.fillMaxWidth()
                                    .padding(
                                        start = 20.dp,
                                        end = 20.dp,
                                        top = 20.dp,
                                        bottom = 4.dp,
                                    ),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    label,
                                    Modifier.weight(1f),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    "${people.size} 人",
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        items(people, key = { label + it.email.lowercase() }) { contact ->
                            val key = label + contact.email.lowercase(Locale.ROOT)
                            val expanded = expandedKey == key
                            Column(Modifier.fillMaxWidth()) {
                                Row(
                                    Modifier.fillMaxWidth()
                                        .clickable { expandedKey = if (expanded) null else key }
                                        .padding(horizontal = 20.dp, vertical = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    Surface(
                                        shape = CircleShape,
                                        color = MaterialTheme.colorScheme.surfaceVariant,
                                    ) {
                                        Box(
                                            Modifier.size(34.dp),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(
                                                contact.label.take(1),
                                                fontSize = 14.sp,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            contact.label,
                                            fontSize = 15.sp,
                                            lineHeight = 21.sp,
                                            color = MaterialTheme.colorScheme.onSurface,
                                        )
                                        if (contact.name.isNotBlank())
                                            Text(
                                                contact.email,
                                                Modifier.padding(top = 3.dp),
                                                fontSize = 12.sp,
                                                lineHeight = 18.sp,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                    }
                                    Text(
                                        if (expanded) "⌄" else "›",
                                        fontSize = 19.sp,
                                        color = MaterialTheme.colorScheme.outline,
                                    )
                                }
                                AnimatedVisibility(
                                    visible = expanded,
                                    enter = expandVertically(tween(180)) + fadeIn(tween(120)),
                                    exit = shrinkVertically(tween(150)) + fadeOut(tween(100)),
                                ) {
                                    MailPersonActions(vm, contact)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MailPersonActions(vm: MailViewModel, contact: MailContact) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(contact.email) { mutableStateOf(false) }
    var attempted by remember(contact.email) { mutableStateOf(false) }
    val saved = vm.contacts.any { it.email.equals(contact.email, true) && it.name == contact.name }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2200)
            copied = false
        }
    }
    Column(Modifier.fillMaxWidth().padding(start = 66.dp, end = 20.dp, bottom = 12.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(
                onClick = {
                    scope.launch {
                        clipboard.setClipEntry(
                            ClipEntry(ClipData.newPlainText("邮箱", contact.email))
                        )
                        copied = true
                    }
                }
            ) {
                Text(
                    if (copied) "已复制邮箱" else "复制邮箱",
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    fontSize = 12.sp,
                )
            }
            if (!saved && !contact.email.equals(vm.account?.email, true))
                TextButton(
                    onClick = {
                        attempted = true
                        vm.saveContact(contact)
                    },
                    enabled = !vm.busy,
                ) {
                    Text(if (vm.busy) "保存中…" else "存入通讯录", fontSize = 12.sp)
                }
        }
        if (saved)
            Text(
                "已在通讯录",
                Modifier.padding(start = 12.dp),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        if (attempted && vm.error)
            Text(
                vm.status,
                Modifier.padding(top = 8.dp),
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.error,
            )
    }
}

@Composable
internal fun RecipientEditor(
    vm: MailViewModel,
    draft: Draft,
    editable: Boolean,
    field: String = "to",
    next: () -> Unit,
) {
    val raw =
        when (field) {
            "cc" -> draft.cc
            "bcc" -> draft.bcc
            else -> draft.to
        }
    val compact =
        LocalConfiguration.current.screenWidthDp < 360 || LocalDensity.current.fontScale > 1.3f
    val label =
        when (field) {
            "cc" -> "抄送"
            "bcc" -> "密送"
            else -> "收件人"
        }
    fun change(value: String) {
        val current = vm.draft?.takeIf { it.id == draft.id } ?: return
        vm.update(
            when (field) {
                "cc" -> current.copy(cc = value)
                "bcc" -> current.copy(bcc = value)
                else -> current.copy(to = value)
            }
        )
    }
    var editing by remember(draft.id) { mutableStateOf(raw.isBlank()) }
    var picking by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    val requester = remember { FocusRequester() }
    var requestFocus by remember { mutableStateOf(false) }
    val people = remember(raw) { MailAddresses.parse(raw) }
    val valid = remember(raw) { runCatching { MimeCodec.addresses(raw) }.isSuccess }
    LaunchedEffect(editing, requestFocus) {
        if (editing && requestFocus) {
            requester.requestFocus()
            requestFocus = false
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(composerLabelWidth()), fontSize = 15.sp)
        if (editing || !valid || people.isEmpty()) {
            OutlinedTextField(
                value = raw,
                onValueChange = ::change,
                placeholder = { Text("输入邮箱地址", fontSize = 14.sp) },
                readOnly = !editable,
                minLines = 1,
                maxLines = 3,
                keyboardOptions =
                    KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                keyboardActions =
                    KeyboardActions(
                        onNext = {
                            next()
                            if (valid) editing = false
                        }
                    ),
                modifier =
                    Modifier.weight(1f)
                        .focusRequester(requester)
                        .testTag(if (field == "to") "compose-recipient" else "compose-$field")
                        .semantics { contentDescription = label }
                        .onFocusChanged { if (!it.isFocused && valid) editing = false },
                shape = RoundedCornerShape(18.dp),
                textStyle = LocalTextStyle.current.copy(fontSize = 15.sp),
                colors =
                    OutlinedTextFieldDefaults.colors(
                        unfocusedBorderColor = Color.Transparent,
                        focusedBorderColor = Color.Transparent,
                        disabledBorderColor = Color.Transparent,
                        focusedContainerColor = composerFieldColor(),
                        unfocusedContainerColor = composerFieldColor(),
                        disabledContainerColor = composerFieldColor(),
                    ),
            )
        } else {
            Surface(
                modifier = Modifier.weight(1f).testTag("compose-recipient-summary-$field"),
                shape = RoundedCornerShape(18.dp),
                color = composerFieldColor(),
            ) {
                Column(
                    Modifier.fillMaxWidth()
                        .clickable { details = true }
                        .heightIn(min = 56.dp)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    val count =
                        if (people.size > 2) "等 ${people.size} 人 ›" else "${people.size} 人 ›"
                    if (compact) {
                        Text(
                            people.take(1).joinToString { it.label },
                            fontSize = 15.sp,
                            lineHeight = 20.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            count,
                            Modifier.padding(top = 3.dp),
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    } else
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                people.take(2).joinToString("、") { it.label },
                                Modifier.weight(1f),
                                fontSize = 15.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                count,
                                Modifier.padding(start = 6.dp),
                                fontSize = 12.sp,
                                maxLines = 1,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                }
            }
        }
        IconButton(onClick = { picking = true }, enabled = editable) {
            ComposeIcon(
                com.mailai.mobile.R.drawable.ic_compose_contacts,
                if (field == "to") "通讯录" else "$label 通讯录",
            )
        }
    }
    if (picking)
        ContactPicker(vm, raw, field) {
            picking = false
            editing = false
        }
    if (details)
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text("$label · ${people.size} 人") },
            text = {
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(people, key = { it.email.lowercase() }) { contact ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(contact.label, fontSize = 14.sp)
                                if (contact.name.isNotBlank()) Text(contact.email, fontSize = 12.sp)
                            }
                            if (editable)
                                TextButton(
                                    onClick = {
                                        change(
                                            people
                                                .filterNot { it.email.equals(contact.email, true) }
                                                .joinToString { it.address() }
                                        )
                                    }
                                ) {
                                    Text("移除", fontSize = 12.sp)
                                }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { details = false }) { Text("完成") } },
            dismissButton = {
                if (editable)
                    TextButton(
                        onClick = {
                            details = false
                            editing = true
                            requestFocus = true
                        }
                    ) {
                        Text("编辑地址")
                    }
            },
        )
}
