package com.mailai.mobile.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*

internal fun peopleSummary(mail: MailItem, ownEmail: String): String {
    val people =
        (MailAddresses.parse(mail.recipients) + MailAddresses.parse(mail.cc)).distinctBy {
            it.email.lowercase()
        }
    val me = people.any { it.email.equals(ownEmail, true) }
    val first = if (me) "我" else people.firstOrNull()?.label ?: "收件人"
    return if (people.size > 1) "发给$first · 共 ${people.size} 人" else "发给$first"
}

@Composable
internal fun MailPeopleDialog(vm: MailViewModel, mail: MailItem, close: () -> Unit) {
    val groups =
        listOf(
            "发件人" to MailAddresses.parse(mail.sender),
            "收件人" to MailAddresses.parse(mail.recipients),
            "抄送" to MailAddresses.parse(mail.cc),
        )
    AlertDialog(
        onDismissRequest = close,
        title = { Text("邮件详情") },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 440.dp)) {
                item {
                    Text(mail.subject, fontSize = 15.sp)
                    Spacer(Modifier.height(12.dp))
                }
                groups.forEach { (label, people) ->
                    if (people.isNotEmpty()) {
                        item {
                            Text(
                                "$label · ${people.size} 人",
                                Modifier.padding(top = 12.dp, bottom = 8.dp),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        items(people, key = { label + it.email.lowercase() }) { contact ->
                            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                                SelectionContainer {
                                    Column {
                                        Text(contact.label, fontSize = 14.sp)
                                        if (contact.name.isNotBlank())
                                            Text(contact.email, fontSize = 12.sp)
                                    }
                                }
                                if (
                                    vm.contacts.none {
                                        it.email.equals(contact.email, true) &&
                                            it.name == contact.name
                                    }
                                )
                                    TextButton(
                                        onClick = { vm.saveContact(contact) },
                                        enabled = !vm.busy,
                                    ) {
                                        Text("存入通讯录", fontSize = 12.sp)
                                    }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = close) { Text("完成") } },
    )
}

@Composable
internal fun RecipientEditor(vm: MailViewModel, draft: Draft, editable: Boolean, next: () -> Unit) {
    var editing by remember(draft.id) { mutableStateOf(draft.to.isBlank()) }
    var picking by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    val requester = remember { FocusRequester() }
    var requestFocus by remember { mutableStateOf(false) }
    val people = remember(draft.to) { MailAddresses.parse(draft.to) }
    val valid = remember(draft.to) { runCatching { MimeCodec.addresses(draft.to) }.isSuccess }
    LaunchedEffect(editing, requestFocus) {
        if (editing && requestFocus) {
            requester.requestFocus()
            requestFocus = false
        }
    }
    if (editing || !valid || people.isEmpty()) {
        TextField(
            value = draft.to,
            onValueChange = { vm.update(draft.copy(to = it)) },
            label = { Text("收件人") },
            readOnly = !editable,
            minLines = 1,
            maxLines = 5,
            trailingIcon = {
                TextButton(onClick = { picking = true }, enabled = editable) {
                    Text("通讯录", fontSize = 12.sp)
                }
            },
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
                Modifier.fillMaxWidth().focusRequester(requester).onFocusChanged {
                    if (!it.isFocused && valid) editing = false
                },
            shape = RoundedCornerShape(14.dp),
            colors =
                TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
        )
    } else {
        Surface(
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, bottom = 8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "收件人",
                        Modifier.weight(1f),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { picking = true }, enabled = editable) {
                        Text("通讯录", fontSize = 12.sp)
                    }
                }
                Row(
                    Modifier.fillMaxWidth().clickable { details = true }.heightIn(min = 40.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        people.take(2).joinToString("、") { it.label },
                        Modifier.weight(1f),
                        fontSize = 15.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        if (people.size > 2) "等 ${people.size} 人 ›" else "${people.size} 人 ›",
                        Modifier.padding(start = 8.dp),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
    if (picking)
        ContactPicker(vm, draft.to) {
            picking = false
            editing = false
        }
    if (details)
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text("收件人 · ${people.size} 人") },
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
                                        vm.update(
                                            draft.copy(
                                                to =
                                                    people
                                                        .filterNot {
                                                            it.email.equals(contact.email, true)
                                                        }
                                                        .joinToString { it.address() }
                                            )
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
