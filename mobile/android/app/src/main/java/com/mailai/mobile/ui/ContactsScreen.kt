package com.mailai.mobile.ui

import android.app.Activity
import android.content.Intent
import android.provider.ContactsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.mailai.mobile.mail.*

@Composable
internal fun ContactsScreen(vm: MailViewModel) {
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<MailContact?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        PageHeader("通讯录", { vm.go("boxes") }) {
            TextButton(onClick = { adding = true }, enabled = !vm.busy) {
                Text("新建联系人", fontSize = 13.sp)
            }
        }
        val filtered = vm.contacts.filter { (it.name + it.email).contains(query, true) }
        LazyColumn(Modifier.weight(1f).testTag("contacts-list")) {
            item(key = "search") {
                Text(
                    "此邮箱的往来联系人，保存在这台设备",
                    Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SearchInput(
                    query,
                    { query = it },
                    "搜索联系人",
                    Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
            if (filtered.isEmpty())
                item {
                    Text(
                        if (query.isBlank()) "暂无联系人，收信或写信后会逐步整理，也可以新建。" else "没有匹配的联系人",
                        Modifier.padding(22.dp),
                        fontSize = 14.sp,
                    )
                }
            items(filtered, key = { it.email.lowercase() }) { contact ->
                MailCard(Modifier.padding(horizontal = 16.dp, vertical = 2.dp)) {
                    ContactRow(contact, edit = { editing = contact }) {
                        vm.compose()
                        vm.addRecipients(listOf(contact))
                    }
                }
            }
        }
    }
    if (adding || editing != null)
        AddContactDialog(vm, editing) {
            adding = false
            editing = null
        }
}

@Composable
private fun ContactRow(contact: MailContact, edit: () -> Unit, action: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClick = action)
            .padding(horizontal = 22.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ContactAvatar(contact.label)
        Column(Modifier.weight(1f)) {
            Text(contact.label, fontSize = 15.sp)
            if (contact.name.isNotBlank())
                Text(
                    contact.email,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
        }
        Box {
            IconButton(onClick = { menu = true }) { MailIcon(MailGlyph.More, "联系人操作") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text("编辑联系人") },
                    onClick = {
                        menu = false
                        edit()
                    },
                )
                DropdownMenuItem(
                    text = { Text("写信") },
                    onClick = {
                        menu = false
                        action()
                    },
                )
            }
        }
    }
}

@Composable
internal fun AddContactDialog(vm: MailViewModel, contact: MailContact? = null, close: () -> Unit) {
    var name by remember { mutableStateOf(contact?.name.orEmpty()) }
    var email by remember { mutableStateOf(contact?.email.orEmpty()) }
    var error by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(if (contact == null) "新建联系人" else "编辑联系人") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    name,
                    { name = it },
                    label = { Text("姓名（选填）") },
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                )
                OutlinedTextField(
                    email,
                    {
                        email = it
                        error = ""
                    },
                    label = { Text("邮箱地址") },
                    enabled = contact == null,
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                )
                if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    try {
                        val address = MimeCodec.addresses(email.trim())
                        require(address.size == 1)
                        vm.saveContact(MailContact(address.single().address, name.trim()))
                        close()
                    } catch (_: Exception) {
                        error = "请填写一个有效邮箱地址"
                    }
                },
                enabled = !vm.busy,
            ) {
                Text("保存联系人")
            }
        },
        dismissButton = { TextButton(onClick = close) { Text("取消") } },
    )
}

@Composable
internal fun ContactPicker(
    vm: MailViewModel,
    selectedRaw: String,
    field: String = "to",
    close: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val context = LocalContext.current
    val existing =
        remember(selectedRaw) {
            MailAddresses.parse(selectedRaw).map { it.email.lowercase() }.toSet()
        }
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result
            ->
            val uri = result.data?.data
            if (result.resultCode == Activity.RESULT_OK && uri != null) {
                runCatching {
                        context.contentResolver
                            .query(
                                uri,
                                arrayOf(
                                    ContactsContract.CommonDataKinds.Email.ADDRESS,
                                    ContactsContract.CommonDataKinds.Email.DISPLAY_NAME,
                                ),
                                null,
                                null,
                                null,
                            )
                            ?.use { c ->
                                if (c.moveToFirst()) {
                                    val email = c.getString(0).orEmpty()
                                    val name = c.getString(1).orEmpty()
                                    require(MimeCodec.addresses(email).size == 1)
                                    if (vm.addRecipients(listOf(MailContact(email, name)), field))
                                        close()
                                }
                            }
                    }
                    .onFailure { vm.showMessage("无法读取所选邮箱地址，请手动填写", true) }
            }
        }
    Dialog(
        onDismissRequest = close,
        properties =
            DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            MailSystemBars()
            val focus = LocalFocusManager.current
            val keyboard = LocalSoftwareKeyboardController.current
            LaunchedEffect(Unit) {
                focus.clearFocus()
                keyboard?.hide()
            }
            val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
            Column(
                Modifier.fillMaxSize().safeDrawingPadding().imePadding().testTag("contact-picker")
            ) {
                PageHeader(
                    when (field) {
                        "cc" -> "选择抄送"
                        "bcc" -> "选择密送"
                        else -> if (LocalDensity.current.fontScale > 1.5f) "收件人" else "选择收件人"
                    },
                    close,
                ) {
                    Button(
                        onClick = {
                            if (
                                vm.addRecipients(
                                    vm.contacts.filter { it.email.lowercase() in selected },
                                    field,
                                )
                            )
                                close()
                        },
                        enabled =
                            selected.isNotEmpty() &&
                                selected.size + existing.size <= 50 &&
                                !vm.busy,
                        shape = RoundedCornerShape(24.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp),
                    ) {
                        Text("确定 (${selected.size})", fontSize = 13.sp)
                    }
                }
                SearchInput(
                    query,
                    { query = it },
                    "搜索姓名或邮箱",
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("contact-search"),
                )
                val list = vm.contacts.filter { (it.name + it.email).contains(query, true) }
                if (!keyboardVisible)
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (query.isBlank()) "往来联系人" else "搜索结果",
                            Modifier.weight(1f),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "${list.size} 位",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                if (selected.size + existing.size > 50)
                    Text(
                        "单封邮件最多添加 50 位收件人，请减少选择",
                        Modifier.padding(horizontal = 20.dp),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                LazyColumn(
                    Modifier.weight(1f).testTag("contact-picker-list"),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    if (list.isEmpty())
                        item {
                            Text(
                                "暂无匹配的往来联系人，可从手机选择或返回手动填写。",
                                Modifier.padding(20.dp),
                                fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    itemsIndexed(list, key = { _, contact -> contact.email.lowercase() }) {
                        index,
                        contact ->
                        val key = contact.email.lowercase()
                        val added = key in existing
                        Surface(
                            color = MaterialTheme.colorScheme.surface,
                            shape =
                                RoundedCornerShape(
                                    topStart = if (index == 0) 16.dp else 0.dp,
                                    topEnd = if (index == 0) 16.dp else 0.dp,
                                    bottomStart = if (index == list.lastIndex) 16.dp else 0.dp,
                                    bottomEnd = if (index == list.lastIndex) 16.dp else 0.dp,
                                ),
                        ) {
                            Row(
                                Modifier.fillMaxWidth()
                                    .toggleable(
                                        value = added || key in selected,
                                        enabled = !added && !vm.busy,
                                        role = Role.Checkbox,
                                    ) { checked ->
                                        selected = if (checked) selected + key else selected - key
                                        focus.clearFocus()
                                        keyboard?.hide()
                                    }
                                    .padding(horizontal = 14.dp, vertical = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                ContactAvatar(contact.label)
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        contact.label,
                                        fontSize = 15.sp,
                                        lineHeight = 20.sp,
                                        fontWeight = FontWeight.Medium,
                                    )
                                    if (contact.name.isNotBlank())
                                        Text(
                                            contact.email,
                                            Modifier.padding(top = 3.dp),
                                            fontSize = 12.sp,
                                            lineHeight = 16.sp,
                                            maxLines = if (keyboardVisible) 1 else 2,
                                            overflow =
                                                androidx.compose.ui.text.style.TextOverflow
                                                    .Ellipsis,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                }
                                if (added)
                                    Text(
                                        "已添加",
                                        fontSize = 11.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                else
                                    Surface(
                                        shape = CircleShape,
                                        color =
                                            if (key in selected) MaterialTheme.colorScheme.primary
                                            else Color.Transparent,
                                        border =
                                            if (key in selected) null
                                            else
                                                BorderStroke(
                                                    1.dp,
                                                    MaterialTheme.colorScheme.outline,
                                                ),
                                    ) {
                                        Box(
                                            Modifier.size(24.dp),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            if (key in selected)
                                                MailIcon(
                                                    MailGlyph.Check,
                                                    modifier = Modifier.size(17.dp),
                                                    tint = MaterialTheme.colorScheme.onPrimary,
                                                )
                                        }
                                    }
                            }
                        }
                        HorizontalDivider(
                            Modifier.padding(horizontal = 16.dp),
                            color = MaterialTheme.colorScheme.outlineVariant,
                        )
                    }
                }
                if (!keyboardVisible)
                    TextButton(
                        onClick = {
                            try {
                                picker.launch(
                                    Intent(Intent.ACTION_PICK)
                                        .setDataAndType(
                                            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
                                            ContactsContract.CommonDataKinds.Email.CONTENT_TYPE,
                                        )
                                )
                            } catch (_: android.content.ActivityNotFoundException) {
                                vm.showMessage("此设备没有可用的手机通讯录，请使用往来联系人或手动填写")
                            }
                        },
                        modifier = Modifier.fillMaxWidth().padding(8.dp),
                    ) {
                        Text("从手机通讯录选择")
                    }
            }
        }
    }
}
