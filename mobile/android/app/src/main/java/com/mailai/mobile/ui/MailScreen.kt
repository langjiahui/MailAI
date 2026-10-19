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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
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
import com.mailai.mobile.R
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
                if (vm.ready && !vm.online)
                    Text(
                        "当前离线 · 可以阅读缓存、继续写草稿",
                        Modifier.fillMaxWidth()
                            .padding(horizontal = 18.dp, vertical = 8.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
            if (vm.operationHint.isNotBlank())
                Text(
                    vm.operationHint,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier =
                        Modifier.padding(top = 6.dp).semantics {
                            liveRegion = LiveRegionMode.Polite
                        },
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
    var advanced by rememberSaveable(editing?.id) { mutableStateOf(false) }
    var custom by
        rememberSaveable(editing?.id) {
            mutableStateOf(editing != null && AccountSetup.profile(editing.email) == null)
        }
    var visiblePassword by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val profile = AccountSetup.profile(email)
    val hasAddress = email.contains('@') && AccountSetup.domain(email).contains('.')
    val showServers = custom
    val canSubmit = hasAddress && password.isNotBlank() && imap.isNotBlank() && smtp.isNotBlank()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (vm.accounts.isNotEmpty()) {
            Nav(
                if (vm.accounts.isNotEmpty()) "邮箱" else "MailAI",
                back,
                !vm.busy && vm.accounts.isNotEmpty(),
            ) {}
        }
        Column(
            Modifier.padding(horizontal = 24.dp).padding(top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Image(
                    painterResource(R.drawable.mailai_brand),
                    contentDescription = null,
                    modifier = Modifier.size(44.dp),
                )
                Text("MailAI", fontSize = 16.sp, fontWeight = FontWeight.Medium)
            }
            Text(
                if (editing == null) "连接你的邮箱" else "更新邮箱登录",
                fontSize = 27.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text("收发邮件，从这里开始", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(
            Modifier.padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            AccountField(
                "邮箱地址",
                email,
                { next ->
                    if (AccountSetup.domain(next) != AccountSetup.domain(email)) {
                        val detected = AccountSetup.suggested(next)
                        username = ""
                        imap = detected?.imap.orEmpty()
                        smtp = detected?.smtp.orEmpty()
                        ip = "993"
                        sp = "465"
                        itls = true
                        stls = true
                        custom = false
                        validation = ""
                    }
                    email = next
                },
                !vm.busy && editing == null,
                KeyboardType.Email,
            )
            AccountField(
                title = "密码或授权码",
                value = password,
                change = {
                    password = it
                    validation = ""
                },
                enabled = !vm.busy,
                password = !visiblePassword,
                trailingIcon = {
                    TextButton(
                        onClick = { visiblePassword = !visiblePassword },
                        enabled = !vm.busy,
                    ) {
                        Text(if (visiblePassword) "隐藏" else "显示", fontSize = 12.sp)
                    }
                },
                keyboard = KeyboardType.Password,
                done = true,
            )
            if (hasAddress && imap.isNotBlank() && smtp.isNotBlank()) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .55f),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (profile != null) profile.label else "收发服务器",
                                modifier = Modifier.weight(1f),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            TextButton(onClick = { custom = !custom }, enabled = !vm.busy) {
                                Text(if (custom) "收起" else "修改", fontSize = 12.sp)
                            }
                        }
                        if (!showServers) {
                            Text(imap, fontSize = 13.sp)
                            Text(smtp, fontSize = 13.sp)
                            if (profile == null && editing == null)
                                Text(
                                    "按邮箱域名填入，连接前请确认",
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                        }
                    }
                }
            }
            AnimatedVisibility(showServers || (hasAddress && (imap.isBlank() || smtp.isBlank()))) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AccountField(
                        "收信服务器",
                        imap,
                        {
                            imap = it
                            validation = ""
                        },
                        !vm.busy,
                        KeyboardType.Uri,
                    )
                    AccountField(
                        "发信服务器",
                        smtp,
                        {
                            smtp = it
                            validation = ""
                        },
                        !vm.busy,
                        KeyboardType.Uri,
                        done = true,
                    )
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
                    keyboard?.hide()
                    val inPort = ip.toIntOrNull()
                    val outPort = sp.toIntOrNull()
                    if (
                        inPort == null ||
                            outPort == null ||
                            inPort !in 1..65535 ||
                            outPort !in 1..65535
                    ) {
                        validation = "请在高级设置中填写有效端口（1–65535）"
                        advanced = true
                    } else {
                        val account =
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
                            )
                        try {
                            AccountSetup.requireMatchingProvider(account)
                            validation = ""
                            vm.add(account, password)
                        } catch (e: IllegalArgumentException) {
                            validation = e.message.orEmpty()
                            custom = true
                        }
                    }
                },
                enabled = !vm.busy && canSubmit,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                if (vm.busy) {
                    CircularProgressIndicator(
                        Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    if (vm.busy) "正在连接…" else if (editing == null) "连接邮箱" else "保存并连接",
                    fontSize = 15.sp,
                )
            }
            Text(
                if (!hasAddress) "密码仅加密保存在这台设备上"
                else if (profile != null && !custom) "请先在邮箱网页开启 IMAP/SMTP，并使用客户端授权码。"
                else "使用加密连接；专用端口或登录名可在高级设置中修改",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = { advanced = !advanced }, enabled = !vm.busy) {
                Text(if (advanced) "收起高级设置" else "高级设置")
            }
            AnimatedVisibility(advanced) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AccountField("发件人名称（选填）", name, { name = it }, !vm.busy)
                    AccountField("登录用户名（默认邮箱地址）", username, { username = it }, !vm.busy)
                    AccountField("IMAP 端口", ip, { ip = it }, !vm.busy, KeyboardType.Number)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = itls,
                            onCheckedChange = {
                                itls = it
                                ip = if (it) "993" else "143"
                            },
                            enabled = !vm.busy,
                        )
                        Text(if (itls) "收信 · TLS" else "收信 · STARTTLS", fontSize = 13.sp)
                    }
                    AccountField("SMTP 端口", sp, { sp = it }, !vm.busy, KeyboardType.Number)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = stls,
                            onCheckedChange = {
                                stls = it
                                sp = if (it) "465" else "587"
                            },
                            enabled = !vm.busy,
                        )
                        Text(if (stls) "发信 · TLS" else "发信 · STARTTLS", fontSize = 13.sp)
                    }
                    Text(
                        "只支持 IMAP/SMTP；需要 OAuth 的邮箱暂不支持。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun AccountField(
    title: String,
    value: String,
    change: (String) -> Unit,
    enabled: Boolean,
    keyboard: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
    done: Boolean = false,
    trailingIcon: (@Composable () -> Unit)? = null,
) {
    val focus = LocalFocusManager.current
    val ime = LocalSoftwareKeyboardController.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            title,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = value,
            onValueChange = change,
            enabled = enabled,
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontSize = 16.sp),
            shape = RoundedCornerShape(14.dp),
            colors =
                OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surface,
                    unfocusedContainerColor =
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .35f),
                    disabledContainerColor =
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .25f),
                    focusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = .65f),
                    unfocusedBorderColor = MaterialTheme.colorScheme.onSurface.copy(alpha = .12f),
                    disabledBorderColor = MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
                ),
            visualTransformation =
                if (password) PasswordVisualTransformation()
                else androidx.compose.ui.text.input.VisualTransformation.None,
            trailingIcon = trailingIcon,
            keyboardOptions =
                KeyboardOptions(
                    keyboardType = keyboard,
                    imeAction = if (done) ImeAction.Done else ImeAction.Next,
                ),
            keyboardActions =
                KeyboardActions(
                    onNext = { focus.moveFocus(FocusDirection.Next) },
                    onDone = { ime?.hide() },
                ),
            modifier =
                Modifier.fillMaxWidth().heightIn(min = 54.dp).semantics {
                    contentDescription = title
                },
        )
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
