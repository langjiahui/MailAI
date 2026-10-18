package com.mailai.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.mailai.mobile.data.*
import java.text.SimpleDateFormat
import java.util.*

private val Light =
    lightColorScheme(
        primary = Color(0xFF334A3B),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFE6EBE2),
        onPrimaryContainer = Color(0xFF243226),
        secondary = Color(0xFF55624F),
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFE4E9DF),
        onSecondaryContainer = Color(0xFF243226),
        outline = Color(0xFF788273),
        background = Color(0xFFFDFDFB),
        onBackground = Color(0xFF242923),
        surface = Color(0xFFFDFDFB),
        surfaceVariant = Color(0xFFF0F1EE),
        surfaceContainerHighest = Color(0xFFE5E8E1),
        surfaceContainer = Color(0xFFF0F1EE),
        surfaceContainerHigh = Color(0xFFECEEE8),
        surfaceContainerLow = Color(0xFFF7F8F3),
        surfaceTint = Color(0xFF334A3B),
        onSurface = Color(0xFF242923),
        onSurfaceVariant = Color(0xFF687063),
        outlineVariant = Color(0xFFECEEE8),
    )
private val Dark =
    darkColorScheme(
        primary = Color(0xFFC5D4BD),
        onPrimary = Color(0xFF20271D),
        primaryContainer = Color(0xFF334A3B),
        onPrimaryContainer = Color(0xFFC5D4BD),
        secondary = Color(0xFFB7C7AF),
        onSecondary = Color(0xFF20301F),
        secondaryContainer = Color(0xFF334A3B),
        onSecondaryContainer = Color(0xFFDAE5D2),
        outline = Color(0xFF788273),
        background = Color(0xFF171A18),
        onBackground = Color(0xFFECEEE7),
        surface = Color(0xFF171A18),
        surfaceVariant = Color(0xFF252A26),
        surfaceContainerHighest = Color(0xFF353C34),
        surfaceContainer = Color(0xFF252A26),
        surfaceContainerHigh = Color(0xFF2E352E),
        surfaceContainerLow = Color(0xFF1D221D),
        surfaceTint = Color(0xFFC5D4BD),
        onSurface = Color(0xFFECEEE7),
        onSurfaceVariant = Color(0xFFABB2A6),
        outlineVariant = Color(0xFF32392F),
    )

@Composable
fun MailScreen(vm: MailViewModel, open: (Account, Attachment, Boolean) -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light) {
        val view = LocalView.current
        val focus = LocalFocusManager.current
        val keyboard = LocalSoftwareKeyboardController.current
        LaunchedEffect(vm.busy, vm.page) {
            // Keep actions and feedback visible when a submitted form starts network work.
            focus.clearFocus()
            keyboard?.hide()
        }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(vm, lifecycle) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                vm.feedback.collect {
                    view.performHapticFeedback(
                        if (android.os.Build.VERSION.SDK_INT >= 30)
                            android.view.HapticFeedbackConstants.CONFIRM
                        else android.view.HapticFeedbackConstants.VIRTUAL_KEY
                    )
                }
            }
        }
        val inboxList =
            rememberSaveable(vm.account?.id, vm.folder, saver = LazyListState.Saver) {
                LazyListState()
            }
        var leave by remember { mutableStateOf(false) }
        var confirmSend by remember { mutableStateOf(false) }
        fun back() {
            if (vm.busy) {
                vm.cancel()
                return
            }
            when (vm.page) {
                "compose" ->
                    if (vm.draft?.state in setOf(SendState.SENT, SendState.UNCERTAIN))
                        vm.go("drafts")
                    else leave = true
                "reader" -> vm.go("inbox")
                "inbox" -> vm.go("boxes")
                "add" -> if (vm.accounts.isNotEmpty()) vm.go("boxes")
                else -> vm.go("inbox")
            }
        }
        BackHandler(enabled = vm.page != "inbox" || vm.busy) { back() }
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.safeDrawingPadding().imePadding().fillMaxSize()) {
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                else Spacer(Modifier.height(4.dp))
                if (vm.status.isNotBlank()) OperationStatus(vm)
                if (!vm.ready)
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("正在读取此设备上的邮箱…")
                    }
                else
                    AnimatedContent(
                        vm.page,
                        modifier = Modifier.weight(1f),
                        transitionSpec = {
                            (fadeIn(tween(180)) +
                                slideInHorizontally(tween(210)) {
                                    if (targetState in listOf("inbox", "boxes")) -it / 20
                                    else it / 20
                                }) togetherWith fadeOut(tween(110))
                        },
                        label = "页面切换",
                    ) { page ->
                        when (page) {
                            "add" -> AddAccount(vm, ::back)
                            "boxes" -> Mailboxes(vm)
                            "reader" -> Reader(vm, ::back)
                            "compose" -> Composer(vm, ::back) { confirmSend = true }
                            "drafts" -> Drafts(vm)
                            "settings" -> PreferencesScreen(vm)
                            else -> Inbox(vm, inboxList)
                        }
                    }
            }
        }
        if (leave)
            AlertDialog(
                onDismissRequest = { leave = false },
                title = { Text("保留这封草稿？") },
                text = { Text("草稿与附件保存在这台手机，离线也可以继续编辑。") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            leave = false
                            vm.saveAndLeave()
                        }
                    ) {
                        Text("保存并返回")
                    }
                },
                dismissButton = {
                    Column(horizontalAlignment = Alignment.End) {
                        TextButton(
                            onClick = {
                                leave = false
                                vm.discard()
                            }
                        ) {
                            Text("放弃草稿")
                        }
                        TextButton(onClick = { leave = false }) { Text("继续编辑") }
                    }
                },
            )
        if (confirmSend)
            AlertDialog(
                onDismissRequest = { confirmSend = false },
                title = { Text("发送这封邮件？") },
                text = {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        Text("发件人：${vm.account?.email}")
                        Spacer(Modifier.height(12.dp))
                        Text("收件人：${vm.draft?.to}")
                        Text("附件：${vm.draft?.attachments?.size ?: 0} 个")
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirmSend = false
                            vm.send()
                        }
                    ) {
                        Text("发送")
                    }
                },
                dismissButton = { TextButton(onClick = { confirmSend = false }) { Text("继续编辑") } },
            )
        vm.availableFile?.let { (account, attachment) ->
            AlertDialog(
                onDismissRequest = { vm.availableFile = null },
                title = { Text(attachment.name) },
                text = { Text("已下载到此设备。打开前请确认你信任发件人。") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            vm.availableFile = null
                            open(account, attachment, false)
                        }
                    ) {
                        Text("打开")
                    }
                },
                dismissButton = {
                    Row {
                        TextButton(
                            onClick = {
                                vm.availableFile = null
                                open(account, attachment, true)
                            }
                        ) {
                            Text("分享")
                        }
                        TextButton(onClick = { vm.availableFile = null }) { Text("关闭") }
                    }
                },
            )
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun OperationStatus(vm: MailViewModel) {
    var clipped by remember(vm.status) { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
            Text(
                vm.status,
                Modifier.padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
                fontSize = 13.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = {
                    clipped =
                        it.didOverflowHeight || (0 until it.lineCount).any(it::isLineEllipsized)
                },
                color =
                    if (vm.error) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (clipped) TextButton(onClick = { details = true }) { Text("详情") }
                if (vm.busy && vm.cancellable) TextButton(onClick = vm::cancel) { Text("取消") }
                else if (!vm.busy) {
                    if (vm.canRetry && (vm.error || vm.status.startsWith("已取消")))
                        TextButton(onClick = vm::retry) { Text("重试") }
                    TextButton(onClick = vm::dismissStatus) { Text("关闭") }
                }
            }
        }
    }
    if (details)
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text(if (vm.error) "操作未完成" else "操作状态") },
            text = { Text(vm.status, Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { TextButton(onClick = { details = false }) { Text("返回") } },
        )
}

@Composable
private fun Heading(title: String, sub: String = "") {
    Column(Modifier.padding(horizontal = 22.dp, vertical = 16.dp)) {
        Text(title, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        if (sub.isNotBlank())
            Text(sub, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun Nav(
    label: String,
    back: () -> Unit,
    enabled: Boolean = true,
    actions: @Composable FlowRowScope.() -> Unit = {},
) {
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        TextButton(onClick = back, enabled = enabled) { Text("‹  $label") }
        actions()
    }
}

@Composable
private fun Empty(title: String, text: String) {
    Column(
        Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontSize = 18.sp)
        Spacer(Modifier.height(12.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp)
    }
}

private fun date(value: Long) =
    if (value == 0L) ""
    else SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(value))

private fun boxName(value: String) = if (value.equals("INBOX", true)) "收件箱" else value

@Composable
private fun Inbox(vm: MailViewModel, listState: LazyListState) {
    Column(Modifier.fillMaxSize()) {
        Nav("邮箱", { vm.go("boxes") }, !vm.busy) {
            TextButton(onClick = { vm.refresh() }, enabled = !vm.busy && vm.account != null) {
                Text("刷新")
            }
        }
        val list =
            vm.mails.filter {
                (!vm.unreadOnly || it.unread) &&
                    (vm.query.isBlank() ||
                        (it.sender + it.subject + it.body.orEmpty()).contains(vm.query, true))
            }
        LazyColumn(Modifier.weight(1f), state = listState) {
            item(key = "heading") {
                Heading(boxName(vm.folder), vm.account?.email ?: "添加邮箱后即可收发邮件")
                Row(
                    Modifier.padding(horizontal = 22.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = !vm.unreadOnly,
                        onClick = { vm.unreadOnly = false },
                        label = { Text("全部") },
                    )
                    FilterChip(
                        selected = vm.unreadOnly,
                        onClick = { vm.unreadOnly = true },
                        label = { Text("未读") },
                    )
                }
            }
            if (list.isEmpty())
                item {
                    Empty(
                        if (vm.busy) "正在收取邮件…" else "暂无邮件",
                        if (vm.query.isNotBlank()) "没有匹配的本地邮件" else "点击刷新收取邮件；离线时仍可查看已有缓存。",
                    )
                }
            items(list, key = { it.key }) { mail ->
                Column(
                    Modifier.fillMaxWidth()
                        .clickable(enabled = !vm.busy) { vm.read(mail) }
                        .padding(horizontal = 22.dp, vertical = 14.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (mail.unread) {
                            Text("•", color = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            mail.sender,
                            Modifier.weight(1f),
                            fontWeight =
                                if (mail.unread) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            date(mail.date),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        mail.subject,
                        fontSize = 15.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    Text(
                        mail.body?.replace('\n', ' ') ?: "点开读取正文",
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (mail.attachments.isNotEmpty())
                        Text(
                            "${mail.attachments.size} 个附件",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                }
                HorizontalDivider(
                    Modifier.padding(start = 22.dp),
                    color = MaterialTheme.colorScheme.outlineVariant,
                )
            }
            if (vm.mails.size >= vm.limit)
                item {
                    TextButton(
                        onClick = { vm.refresh(true) },
                        enabled = !vm.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("加载更早邮件")
                    }
                }
        }
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            TextField(
                value = vm.query,
                onValueChange = { vm.query = it },
                placeholder = {
                    Text("搜索本地邮件", fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions =
                    KeyboardActions(onSearch = { defaultKeyboardAction(ImeAction.Done) }),
                singleLine = true,
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(24.dp),
                colors =
                    TextFieldDefaults.colors(
                        unfocusedIndicatorColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                    ),
            )
            Button(
                onClick = { vm.compose() },
                enabled = !vm.busy && vm.account != null,
                shape = RoundedCornerShape(14.dp),
            ) {
                Text("写信")
            }
        }
    }
}

@Composable
private fun Mailboxes(vm: MailViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Nav("收件箱", { vm.go("inbox") }, !vm.busy) {
            TextButton(onClick = { vm.go("add") }, enabled = !vm.busy) { Text("添加邮箱") }
        }
        Heading("邮箱", "手机独立连接 · 缓存与草稿保存在此设备")
        TextButton(
            onClick = { vm.go("drafts") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            enabled = !vm.busy,
        ) {
            Text("草稿与发送记录", Modifier.weight(1f), fontSize = 17.sp)
            Text(vm.drafts.size.toString())
        }
        vm.accounts.forEach { a ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = { vm.choose(a) },
                    enabled = !vm.busy,
                    modifier = Modifier.weight(1f),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(a.name.ifBlank { a.email }, fontSize = 17.sp)
                        Text(a.email, fontSize = 12.sp)
                    }
                }
                TextButton(onClick = { vm.editAccount(a) }, enabled = !vm.busy) { Text("登录设置") }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text(
            "当前邮箱的文件夹",
            Modifier.padding(horizontal = 22.dp),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        vm.folders.forEach { folder ->
            TextButton(
                onClick = { vm.account?.let { vm.choose(it, folder) } },
                enabled = !vm.busy,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            ) {
                Text(boxName(folder), Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(18.dp))
        TextButton(
            onClick = { vm.go("settings") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
        ) {
            Text("通知与更新", Modifier.weight(1f), fontSize = 17.sp)
            Text("›")
        }
        Text(
            "后台收信 · 更新与安装",
            Modifier.padding(horizontal = 22.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Reader(vm: MailViewModel, back: () -> Unit) {
    val m = vm.selected ?: return
    var details by remember(m.key) { mutableStateOf(false) }
    if (details)
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text("邮件详情") },
            text = {
                SelectionContainer {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        Text("发件人")
                        Text(m.sender)
                        Spacer(Modifier.height(16.dp))
                        Text("收件人")
                        Text(m.recipients)
                        Spacer(Modifier.height(16.dp))
                        Text(date(m.date))
                    }
                }
            },
            confirmButton = { TextButton(onClick = { details = false }) { Text("完成") } },
        )
    Column(Modifier.fillMaxSize()) {
        Nav("${boxName(vm.folder)}", back, !vm.busy) {
            TextButton(onClick = { details = true }, enabled = !vm.busy) { Text("详情") }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp)
        ) {
            Text(
                m.subject,
                fontSize = 25.sp,
                lineHeight = 35.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(top = 14.dp, bottom = 24.dp),
            )
            Text(m.sender.substringBefore(" <"), fontWeight = FontWeight.Medium)
            Text(date(m.date), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(28.dp))
            SelectionContainer {
                Text(
                    m.body ?: if (vm.busy) "正在读取正文…" else "正文未下载，请联网后重试。",
                    fontSize = 16.sp,
                    lineHeight = 29.sp,
                )
            }
            if (m.body != null)
                Text(
                    "文本阅读 · 未加载远程图片",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 18.dp),
                )
            m.attachments.forEach { file ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.padding(vertical = 5.dp),
                ) {
                    TextButton(
                        onClick = { vm.download(file) },
                        enabled = !vm.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(
                                if (file.size < 0) "大小未知" else "${file.size/1024} KB",
                                fontSize = 12.sp,
                            )
                        }
                        Text(if (file.local.isBlank()) "下载" else "打开")
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
        Row(Modifier.fillMaxWidth().padding(18.dp), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = { vm.compose(true) },
                enabled = !vm.busy,
                shape = RoundedCornerShape(14.dp),
            ) {
                Text("回复", Modifier.padding(horizontal = 16.dp))
            }
        }
    }
}

@Composable
private fun Composer(vm: MailViewModel, back: () -> Unit, send: () -> Unit) {
    val d = vm.draft ?: return
    val focus = LocalFocusManager.current
    val bodyRequester = remember { BringIntoViewRequester() }
    var bodyFocused by remember { mutableStateOf(false) }
    val editable = !vm.busy && d.state in setOf(SendState.DRAFT, SendState.FAILED)
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) vm.attach(uri)
        }
    Column(Modifier.fillMaxSize()) {
        Nav("返回", back, !vm.busy) { TextButton(onClick = send, enabled = editable) { Text("发送") } }
        BoxWithConstraints(Modifier.weight(1f)) {
            val editorHeight = (maxHeight * 0.7f).coerceAtLeast(96.dp)
            LaunchedEffect(d.body, editorHeight, bodyFocused) {
                if (bodyFocused) {
                    withFrameNanos {}
                    bodyRequester.bringIntoView()
                }
            }
            Column(
                Modifier.fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 22.dp)
            ) {
                Text(
                    vm.saveStatus,
                    Modifier.fillMaxWidth().padding(vertical = 10.dp).semantics {
                        liveRegion = LiveRegionMode.Polite
                    },
                    fontSize = 12.sp,
                    color =
                        if (vm.saveStatus.contains("失败") || d.state == SendState.UNCERTAIN)
                            MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (vm.saveStatus.startsWith("保存失败"))
                    TextButton(onClick = vm::retrySave, enabled = !vm.busy) { Text("重试保存") }
                Text(
                    "发件人  ${vm.account?.email}",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 14.dp),
                )
                TextField(
                    value = d.to,
                    onValueChange = { vm.update(d.copy(to = it)) },
                    label = { Text("收件人") },
                    singleLine = true,
                    readOnly = !editable,
                    keyboardOptions =
                        KeyboardOptions(
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Next,
                        ),
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }),
                    modifier = Modifier.fillMaxWidth(),
                    colors = paperFields(),
                )
                TextField(
                    value = d.subject,
                    onValueChange = { vm.update(d.copy(subject = it)) },
                    label = { Text("主题") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }),
                    singleLine = true,
                    readOnly = !editable,
                    modifier = Modifier.fillMaxWidth(),
                    colors = paperFields(),
                )
                TextField(
                    value = d.body,
                    onValueChange = { vm.update(d.copy(body = it)) },
                    placeholder = { Text("写下想说的话…") },
                    readOnly = !editable,
                    minLines = 3,
                    modifier =
                        Modifier.fillMaxWidth()
                            .heightIn(max = editorHeight)
                            .bringIntoViewRequester(bodyRequester)
                            .onFocusChanged { bodyFocused = it.isFocused }
                            .testTag("compose-body"),
                    colors = paperFields(),
                )
                d.attachments.forEach { attachment ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(attachment.name, Modifier.weight(1f), fontSize = 13.sp)
                        TextButton(
                            onClick = {
                                vm.update(d.copy(attachments = d.attachments - attachment))
                            },
                            enabled = editable,
                        ) {
                            Text("移除")
                        }
                    }
                }
                if (editable)
                    TextButton(onClick = { picker.launch(arrayOf("*/*")) }) { Text("添加附件") }
            }
        }
    }
}

@Composable
private fun paperFields() =
    TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent,
        unfocusedContainerColor = Color.Transparent,
        disabledContainerColor = Color.Transparent,
        unfocusedIndicatorColor = MaterialTheme.colorScheme.outlineVariant,
    )

@Composable
private fun Drafts(vm: MailViewModel) {
    Column(Modifier.fillMaxSize()) {
        Nav("邮箱", { vm.go("boxes") }, !vm.busy)
        LazyColumn(Modifier.weight(1f)) {
            item { Heading("草稿与发送记录", vm.account?.email.orEmpty()) }
            if (vm.drafts.isEmpty()) item { Empty("暂无草稿", "写信时会自动保存，下次打开仍可继续。") }
            items(vm.drafts, key = { it.id }) { d ->
                Column(
                    Modifier.fillMaxWidth()
                        .clickable(enabled = !vm.busy) { vm.openDraft(d) }
                        .padding(22.dp)
                ) {
                    Text(d.subject.ifBlank { "（无主题）" }, fontSize = 16.sp)
                    Text(d.to.ifBlank { "尚未填写收件人" }, fontSize = 13.sp)
                    Text(
                        when (d.state) {
                            SendState.SENT -> "已发送 · 此设备记录"
                            SendState.UNCERTAIN -> "发送结果待确认 · 请勿重复发送"
                            SendState.FAILED -> "未提交成功 · 可编辑后重试"
                            else -> "草稿 · ${date(d.updated)}"
                        },
                        fontSize = 12.sp,
                        color =
                            if (d.state == SendState.UNCERTAIN) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun AddAccount(vm: MailViewModel, back: () -> Unit) {
    val editing = vm.editingAccount
    var email by rememberSaveable(editing?.id) { mutableStateOf(editing?.email.orEmpty()) }
    var name by rememberSaveable(editing?.id) { mutableStateOf(editing?.name.orEmpty()) }
    var username by rememberSaveable(editing?.id) { mutableStateOf(editing?.username.orEmpty()) }
    var password by remember(editing?.id) { mutableStateOf("") }
    var imap by rememberSaveable(editing?.id) { mutableStateOf(editing?.imap?.host.orEmpty()) }
    var smtp by rememberSaveable(editing?.id) { mutableStateOf(editing?.smtp?.host.orEmpty()) }
    var ip by
        rememberSaveable(editing?.id) { mutableStateOf((editing?.imap?.port ?: 993).toString()) }
    var sp by
        rememberSaveable(editing?.id) { mutableStateOf((editing?.smtp?.port ?: 465).toString()) }
    var itls by
        rememberSaveable(editing?.id) {
            mutableStateOf(editing?.imap?.security != Security.STARTTLS)
        }
    var stls by
        rememberSaveable(editing?.id) {
            mutableStateOf(editing?.smtp?.security != Security.STARTTLS)
        }
    var validation by remember { mutableStateOf("") }
    var advanced by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Nav(
            if (vm.accounts.isNotEmpty()) "邮箱" else "MailAI",
            back,
            !vm.busy && vm.accounts.isNotEmpty(),
        ) {
            TextButton(onClick = { vm.go("settings") }, enabled = !vm.busy) { Text("通知与更新") }
        }
        Heading(if (editing == null) "添加邮箱" else "更新邮箱登录", "手机直接连接邮箱，电脑关机也能使用")
        Column(
            Modifier.padding(horizontal = 22.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "在邮箱网页设置中开启 IMAP/SMTP，使用授权码登录。需要 OAuth 的账户暂不支持。",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow {
                TextButton(
                    onClick = {
                        imap = "imap.qq.com"
                        smtp = "smtp.qq.com"
                        ip = "993"
                        sp = "465"
                        itls = true
                        stls = true
                        advanced = false
                    },
                    enabled = !vm.busy,
                ) {
                    Text("QQ 邮箱")
                }
                TextButton(
                    onClick = {
                        imap = "imap.163.com"
                        smtp = "smtp.163.com"
                        ip = "993"
                        sp = "465"
                        itls = true
                        stls = true
                        advanced = false
                    },
                    enabled = !vm.busy,
                ) {
                    Text("163 邮箱")
                }
                TextButton(onClick = { advanced = true }, enabled = !vm.busy) { Text("其他邮箱") }
            }
            FormField(
                "邮箱地址",
                email,
                { email = it },
                !vm.busy && editing == null,
                KeyboardType.Email,
            )
            TextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("授权码 / 密码", fontSize = 14.sp) },
                singleLine = true,
                enabled = !vm.busy,
                colors = paperFields(),
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions =
                    KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                modifier = Modifier.fillMaxWidth(),
            )
            TextButton(onClick = { advanced = !advanced }, enabled = !vm.busy) {
                Text(if (advanced) "收起服务器设置" else "服务器与发件人设置")
            }
            if (!advanced && imap.isNotBlank())
                Text(
                    "加密连接 · $imap",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            AnimatedVisibility(advanced) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    FormField("发件人名称", name, { name = it }, !vm.busy)
                    FormField("登录用户名", username, { username = it }, !vm.busy)
                    Text(
                        "留空使用邮箱地址",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "收信服务器",
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(top = 14.dp),
                    )
                    FormField("IMAP 地址", imap, { imap = it }, !vm.busy)
                    FormField("IMAP 端口", ip, { ip = it }, !vm.busy, KeyboardType.Number)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = itls,
                            onCheckedChange = {
                                itls = it
                                ip = if (it) "993" else "143"
                            },
                            enabled = !vm.busy,
                        )
                        Text(if (itls) "TLS 加密连接" else "STARTTLS（必须升级加密）", fontSize = 13.sp)
                    }
                    Text("发信服务器", fontWeight = FontWeight.Medium)
                    FormField("SMTP 地址", smtp, { smtp = it }, !vm.busy)
                    FormField("SMTP 端口", sp, { sp = it }, !vm.busy, KeyboardType.Number)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = stls,
                            onCheckedChange = {
                                stls = it
                                sp = if (it) "465" else "587"
                            },
                            enabled = !vm.busy,
                        )
                        Text(if (stls) "TLS 加密连接" else "STARTTLS（必须升级加密）", fontSize = 13.sp)
                    }
                }
            }
            if (validation.isNotBlank())
                Text(
                    validation,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            Button(
                onClick = {
                    val inPort = ip.toIntOrNull()
                    val outPort = sp.toIntOrNull()
                    if (
                        email.isBlank() ||
                            imap.isBlank() ||
                            smtp.isBlank() ||
                            password.isBlank() ||
                            inPort == null ||
                            outPort == null ||
                            inPort !in 1..65535 ||
                            outPort !in 1..65535
                    ) {
                        validation = "请完整填写邮箱、授权码、服务器及有效端口"
                        if (imap.isBlank() || smtp.isBlank()) advanced = true
                    } else {
                        validation = ""
                        vm.add(
                            Account(
                                id = editing?.id ?: UUID.randomUUID().toString(),
                                email = email.trim(),
                                name = name.trim(),
                                username = username.trim().ifBlank { email.trim() },
                                imap =
                                    Server(
                                        imap.trim(),
                                        inPort,
                                        if (itls) Security.TLS else Security.STARTTLS,
                                    ),
                                smtp =
                                    Server(
                                        smtp.trim(),
                                        outPort,
                                        if (stls) Security.TLS else Security.STARTTLS,
                                    ),
                            ),
                            password,
                        )
                    }
                },
                enabled = !vm.busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (vm.busy) "正在验证…" else if (editing == null) "验证并添加" else "验证并更新")
            }
            Text(
                "授权码经 Android Keystore 加密后保存到手机。服务器必须通过 TLS 证书验证。",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun FormField(
    label: String,
    value: String,
    change: (String) -> Unit,
    enabled: Boolean,
    keyboard: KeyboardType = KeyboardType.Text,
) {
    val focus = LocalFocusManager.current
    TextField(
        value = value,
        onValueChange = change,
        label = { Text(label, fontSize = 14.sp) },
        colors = paperFields(),
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }),
        modifier = Modifier.fillMaxWidth(),
    )
}
