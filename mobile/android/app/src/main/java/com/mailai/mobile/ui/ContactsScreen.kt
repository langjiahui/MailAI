package com.mailai.mobile.ui

import android.app.Activity
import android.content.Intent
import android.provider.ContactsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.mail.*

@Composable
internal fun ContactsScreen(vm: MailViewModel) {
    var adding by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = { vm.go("boxes") }) { Text("‹  邮箱") }
            TextButton(onClick = { adding = true }, enabled = !vm.busy) { Text("新建联系人") }
        }
        val filtered = vm.contacts.filter { (it.name + it.email).contains(query, true) }
        LazyColumn(Modifier.weight(1f).testTag("contacts-list")) {
            item(key = "search") {
                Text(
                    "通讯录",
                    Modifier.padding(horizontal = 22.dp, vertical = 10.dp),
                    fontSize = 26.sp,
                )
                Text(
                    "此邮箱的往来联系人，保存在这台设备",
                    Modifier.padding(horizontal = 22.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    query,
                    {
                        query = it
                        if (!vm.busy) vm.dismissStatus()
                    },
                    label = { Text("搜索联系人") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 12.dp),
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
                ContactRow(contact) {
                    vm.compose()
                    vm.addRecipients(listOf(contact))
                }
            }
        }
    }
    if (adding) AddContactDialog(vm) { adding = false }
}

@Composable
private fun ContactRow(contact: MailContact, action: () -> Unit) {
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
        Text("写信", fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
internal fun AddContactDialog(vm: MailViewModel, close: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("新建联系人") },
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
internal fun ContactPicker(vm: MailViewModel, selectedRaw: String, close: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(setOf<String>()) }
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
                                    vm.addRecipients(listOf(MailContact(email, name)))
                                    close()
                                }
                            }
                    }
                    .onFailure { vm.showMessage("无法读取所选邮箱地址，请手动填写", true) }
            }
        }
    AlertDialog(
        onDismissRequest = close,
        title = { Text("选择收件人") },
        text = {
            Column {
                OutlinedTextField(
                    query,
                    { query = it },
                    label = { Text("搜索姓名或邮箱") },
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
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
                    }
                ) {
                    Text("从手机通讯录选择")
                }
                val list = vm.contacts.filter { (it.name + it.email).contains(query, true) }
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 280.dp)) {
                    if (list.isEmpty())
                        item {
                            Text(
                                "暂无匹配的往来联系人，可从手机选择或返回手动填写。",
                                Modifier.padding(vertical = 16.dp),
                                fontSize = 13.sp,
                            )
                        }
                    items(list, key = { it.email.lowercase() }) { contact ->
                        val added = contact.email.lowercase() in existing
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable(enabled = !added) {
                                    selected =
                                        if (contact.email in selected) selected - contact.email
                                        else selected + contact.email
                                }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(contact.label, fontSize = 14.sp)
                                if (contact.name.isNotBlank()) Text(contact.email, fontSize = 12.sp)
                            }
                            if (added) Text("已添加", fontSize = 12.sp)
                            else Checkbox(contact.email in selected, onCheckedChange = null)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    vm.addRecipients(vm.contacts.filter { it.email in selected })
                    close()
                },
                enabled = selected.isNotEmpty(),
            ) {
                Text("添加所选 ${selected.size} 位")
            }
        },
        dismissButton = { TextButton(onClick = close) { Text("取消") } },
    )
}
