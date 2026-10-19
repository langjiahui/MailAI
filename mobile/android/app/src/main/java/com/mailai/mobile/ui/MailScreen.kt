package com.mailai.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
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
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import com.mailai.mobile.mail.MailAddresses
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
        val pageStates = rememberSaveableStateHolder()
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
                "drafts",
                "settings",
                "contacts" -> vm.go(if (vm.accounts.isEmpty()) "add" else "boxes")
                "inbox" -> vm.go("boxes")
                "add" -> if (vm.accounts.isNotEmpty()) vm.go("boxes")
                else -> vm.go("inbox")
            }
        }
        BackHandler(enabled = vm.page != "inbox" || vm.busy) { back() }
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.safeDrawingPadding().imePadding().fillMaxSize()) {
                Column(Modifier.fillMaxSize()) {
                    if (!vm.ready)
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("正在读取此设备上的邮箱…")
                        }
                    else
                        AnimatedContent(
                            vm.page,
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            transitionSpec = {
                                val forward = pageDepth(targetState) > pageDepth(initialState)
                                val entering =
                                    tween<androidx.compose.ui.unit.IntOffset>(
                                        240,
                                        easing = FastOutSlowInEasing,
                                    )
                                val leaving =
                                    tween<androidx.compose.ui.unit.IntOffset>(
                                        200,
                                        easing = FastOutSlowInEasing,
                                    )
                                val incoming =
                                    if (targetState == "compose")
                                        slideInVertically(entering) { it / 12 }
                                    else
                                        slideInHorizontally(entering) {
                                            if (forward) it / 10 else -it / 16
                                        }
                                val outgoing =
                                    if (initialState == "compose")
                                        slideOutVertically(leaving) { it / 12 }
                                    else
                                        slideOutHorizontally(leaving) {
                                            if (forward) -it / 16 else it / 10
                                        }
                                ((incoming + fadeIn(tween(180), initialAlpha = .96f)) togetherWith
                                        (outgoing + fadeOut(tween(80))))
                                    .using(SizeTransform(clip = false) { _, _ -> snap() })
                            },
                            label = "页面切换",
                        ) { page ->
                            // Each page owns its scroll state. Outgoing content fills the same
                            // frame;
                            // navigation actions are guarded against duplicate routes in the view
                            // model.
                            Box(
                                Modifier.fillMaxSize()
                                    .background(MaterialTheme.colorScheme.background)
                            ) {
                                pageStates.SaveableStateProvider(page) {
                                    when (page) {
                                        "add" -> AddAccount(vm, ::back)
                                        "boxes" -> Mailboxes(vm)
                                        "reader" -> Reader(vm, ::back)
                                        "compose" -> Composer(vm, ::back) { confirmSend = true }
                                        "drafts" -> Drafts(vm)
                                        "settings" -> PreferencesScreen(vm)
                                        "contacts" -> ContactsScreen(vm)
                                        else -> Inbox(vm, inboxList)
                                    }
                                }
                            }
                        }
                }
                if (vm.busy)
                    LinearProgressIndicator(
                        Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter)
                    )
                OperationBubble(
                    vm,
                    Modifier.align(Alignment.BottomCenter)
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 82.dp),
                )
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
private fun Heading(title: String, sub: String = "") {
    Column(Modifier.padding(horizontal = 22.dp, vertical = 10.dp)) {
        Text(title, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
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
    var previousQuery by rememberSaveable { mutableStateOf(vm.query) }
    var previousUnread by rememberSaveable { mutableStateOf(vm.unreadOnly) }
    LaunchedEffect(vm.query, vm.unreadOnly) {
        if (previousQuery != vm.query || previousUnread != vm.unreadOnly) {
            previousQuery = vm.query
            previousUnread = vm.unreadOnly
            listState.scrollToItem(0)
        }
    }
    Column(Modifier.fillMaxSize()) {
        Nav("邮箱", { vm.go("boxes") }, !vm.busy) {
            TextButton(onClick = { vm.refresh() }, enabled = !vm.busy && vm.account != null) {
                Text(if (vm.canRetry && (vm.error || vm.status.startsWith("已取消"))) "重试同步" else "刷新")
            }
        }
        val list =
            vm.mails.filter {
                (!vm.unreadOnly || it.unread) &&
                    (vm.query.isBlank() ||
                        (it.sender + it.subject + it.body.orEmpty()).contains(vm.query, true))
            }
        LazyColumn(Modifier.weight(1f).testTag("inbox-list"), state = listState) {
            item(key = "heading") {
                Heading(boxName(vm.folder), vm.account?.email ?: "添加邮箱后即可收发邮件")
                Surface(
                    Modifier.padding(horizontal = 22.dp, vertical = 8.dp),
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(3.dp),
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        listOf("全部", "未读").forEachIndexed { index, label ->
                            val selected = vm.unreadOnly == (index == 1)
                            val fill by
                                animateColorAsState(
                                    if (selected) MaterialTheme.colorScheme.primary
                                    else Color.Transparent,
                                    tween(150),
                                    label = "筛选背景",
                                )
                            Surface(
                                modifier = Modifier.weight(1f),
                                selected = selected,
                                shape = RoundedCornerShape(11.dp),
                                color = fill,
                                onClick = { vm.unreadOnly = index == 1 },
                            ) {
                                Box(
                                    Modifier.heightIn(min = 44.dp).padding(vertical = 10.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        label,
                                        fontSize = 14.sp,
                                        color =
                                            if (selected) MaterialTheme.colorScheme.onPrimary
                                            else MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            if (list.isEmpty())
                item {
                    val filtered = vm.query.isNotBlank() || vm.unreadOnly
                    Empty(
                        when {
                            vm.query.isNotBlank() -> "没有匹配的邮件"
                            vm.unreadOnly -> "暂无未读邮件"
                            vm.busy -> "正在收取邮件…"
                            else -> "暂无邮件"
                        },
                        when {
                            vm.query.isNotBlank() -> "搜索范围是此设备已缓存的邮件"
                            vm.unreadOnly -> "可以查看全部邮件，或刷新检查新邮件。"
                            else -> "点击刷新收取邮件；离线时仍可查看已有缓存。"
                        },
                    )
                    if (filtered)
                        TextButton(
                            onClick = {
                                vm.query = ""
                                vm.unreadOnly = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("查看全部邮件")
                        }
                    else if (!vm.busy && vm.account == null)
                        TextButton(onClick = { vm.go("add") }, modifier = Modifier.fillMaxWidth()) {
                            Text("添加邮箱")
                        }
                }
            items(list, key = { it.key }) { mail ->
                Column(
                    Modifier.fillMaxWidth()
                        .clickable(enabled = !vm.busy) { vm.read(mail) }
                        .padding(horizontal = 22.dp, vertical = 12.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (mail.unread) {
                            Text("•", color = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            MailAddresses.sender(mail.sender).label,
                            Modifier.weight(1f).padding(end = 10.dp),
                            fontWeight =
                                if (mail.unread) FontWeight.SemiBold else FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            listDate(mail.date),
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
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            mail.body?.replace('\n', ' ') ?: "点开读取正文",
                            Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (mail.attachments.isNotEmpty())
                            Text(
                                "${mail.attachments.size} 个附件",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                    }
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
                trailingIcon =
                    if (vm.query.isNotEmpty()) {
                        { TextButton(onClick = { vm.query = "" }) { Text("清除", fontSize = 12.sp) } }
                    } else null,
                modifier = Modifier.weight(1f).testTag("mail-search"),
                shape = RoundedCornerShape(14.dp),
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
                modifier = Modifier.heightIn(min = 56.dp),
            ) {
                Text("写信")
            }
        }
    }
}

@Composable
private fun Mailboxes(vm: MailViewModel) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Brand()
            TextButton(onClick = { vm.go("add") }, enabled = !vm.busy) { Text("添加邮箱") }
        }
        Text(
            "邮箱",
            Modifier.padding(top = 18.dp),
            fontSize = 26.sp,
            fontWeight = FontWeight.SemiBold,
        )
        SectionCaption("我的邮箱")
        MailCard {
            vm.accounts.forEachIndexed { index, a ->
                if (index > 0)
                    HorizontalDivider(
                        Modifier.padding(horizontal = 16.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                AccountRow(
                    a,
                    a.id == vm.account?.id,
                    !vm.busy,
                    choose = { vm.choose(a) },
                    edit = { vm.editAccount(a) },
                )
            }
        }
        SectionCaption("文件夹")
        MailCard {
            vm.folders.forEachIndexed { index, folder ->
                if (index > 0)
                    HorizontalDivider(
                        Modifier.padding(horizontal = 16.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                MenuRow(boxName(folder), enabled = !vm.busy) {
                    vm.account?.let { vm.choose(it, folder) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        MailCard {
            MenuRow("草稿与发送记录", "草稿自动保存在此设备", vm.drafts.size.toString(), !vm.busy) {
                vm.go("drafts")
            }
        }
        Spacer(Modifier.height(16.dp))
        MailCard { MenuRow("通讯录", "往来联系人与手机通讯录", onClick = { vm.go("contacts") }) }
        Spacer(Modifier.height(16.dp))
        MailCard { MenuRow("通知与更新", onClick = { vm.go("settings") }) }
        Text(
            "邮件与草稿保存在这台设备",
            Modifier.padding(vertical = 24.dp).align(Alignment.CenterHorizontally),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Reader(vm: MailViewModel, back: () -> Unit) {
    var lastMail by remember { mutableStateOf(vm.selected) }
    val m = vm.selected ?: lastMail ?: return
    SideEffect { if (vm.selected != null) lastMail = vm.selected }
    val readingScroll = rememberSaveable(m.key, saver = ScrollState.Saver) { ScrollState(0) }
    var details by remember(m.key) { mutableStateOf(false) }
    var attachmentList by remember(m.key) { mutableStateOf(false) }
    var original by rememberSaveable(m.key) { mutableStateOf(true) }
    var link by remember { mutableStateOf<String?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val sender = remember(m.sender) { MailAddresses.sender(m.sender) }
    val files = m.attachments.filter { it.contentId.isBlank() || it.local.isBlank() }
    if (details) MailPeopleDialog(vm, m) { details = false }
    if (attachmentList)
        AlertDialog(
            onDismissRequest = { attachmentList = false },
            title = { Text("附件 · ${files.size}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    files.forEach { file ->
                        TextButton(
                            onClick = {
                                attachmentList = false
                                vm.download(file)
                            },
                            enabled = !vm.busy,
                        ) {
                            FileLabel(file.name, file.size, Modifier.weight(1f))
                            Text(if (file.local.isBlank()) "下载" else "打开")
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { attachmentList = false }) { Text("完成") } },
        )
    link?.let { url ->
        AlertDialog(
            onDismissRequest = { link = null },
            title = { Text("打开链接？") },
            text = { SelectionContainer { Text(url) } },
            confirmButton = {
                TextButton(
                    onClick = {
                        link = null
                        try {
                            context.startActivity(
                                android.content.Intent(
                                    android.content.Intent.ACTION_VIEW,
                                    android.net.Uri.parse(url),
                                )
                            )
                        } catch (_: android.content.ActivityNotFoundException) {
                            vm.showMessage("没有可打开此链接的应用", true)
                        }
                    }
                ) {
                    Text("打开")
                }
            },
            dismissButton = { TextButton(onClick = { link = null }) { Text("取消") } },
        )
    }
    Column(Modifier.fillMaxSize()) {
        Nav(boxName(vm.folder), back, !vm.busy) {
            if (vm.canRetry && (vm.error || vm.status.startsWith("已取消")))
                TextButton(onClick = vm::retry, enabled = !vm.busy) { Text("重试读取") }
            if (m.html != null)
                TextButton(onClick = { original = !original }) {
                    Text(if (original) "文本" else "原版")
                }
            TextButton(onClick = { details = true }) { Text("详情") }
        }
        BoxWithConstraints(Modifier.weight(1f)) {
            val compactHeader = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.5f
            val headerHeight = maxHeight * .45f
            Column(Modifier.fillMaxSize()) {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = headerHeight)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 22.dp)
                ) {
                    Text(
                        m.subject,
                        Modifier.padding(top = 8.dp, bottom = if (compactHeader) 10.dp else 16.dp)
                            .clickable { details = true },
                        fontSize = if (compactHeader) 20.sp else 24.sp,
                        lineHeight = if (compactHeader) 26.sp else 32.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = if (compactHeader) 1 else 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable { details = true }
                            .padding(bottom = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ContactAvatar(sender.label)
                        Column(Modifier.weight(1f)) {
                            Text(
                                sender.label,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                peopleSummary(m, vm.account?.email.orEmpty()) + "  ›",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (!compactHeader)
                                Text(
                                    date(m.date),
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (m.html != null && original) {
                    HtmlMailBody(vm, m, Modifier.fillMaxWidth().weight(1f), onLink = { link = it })
                } else
                    Column(
                        Modifier.fillMaxWidth()
                            .weight(1f)
                            .verticalScroll(readingScroll)
                            .padding(horizontal = 22.dp, vertical = 18.dp)
                    ) {
                        SelectionContainer {
                            Text(
                                m.body ?: if (vm.busy) "正在读取正文…" else "正文未下载，请联网后重试。",
                                fontSize = 16.sp,
                                lineHeight = 28.sp,
                            )
                        }
                        if (m.contentVersion == 0 && vm.online && !vm.busy)
                            TextButton(onClick = { vm.fetchBody(true) }) { Text("重新读取原邮件") }
                        files.forEach { file ->
                            MailCard(Modifier.padding(top = 12.dp)) {
                                Row(
                                    Modifier.fillMaxWidth()
                                        .clickable(enabled = !vm.busy) { vm.download(file) }
                                        .padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    FileLabel(file.name, file.size, Modifier.weight(1f))
                                    Text(
                                        if (file.local.isBlank()) "下载" else "打开",
                                        fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (m.html != null && files.isNotEmpty())
                TextButton(onClick = { attachmentList = true }) { Text("附件 ${files.size}") }
            Button(
                onClick = { vm.compose(true) },
                enabled = !vm.busy,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.weight(1f).heightIn(min = 50.dp),
            ) {
                Text("回复")
            }
        }
    }
}

@Composable
private fun Composer(vm: MailViewModel, back: () -> Unit, send: () -> Unit) {
    var lastDraft by remember { mutableStateOf(vm.draft) }
    val d = vm.draft ?: lastDraft ?: return
    SideEffect { if (vm.draft != null) lastDraft = vm.draft }
    val editorScroll = rememberSaveable(d.id, saver = ScrollState.Saver) { ScrollState(0) }
    val focus = LocalFocusManager.current
    val subjectRequester = remember { FocusRequester() }
    val bodyRequester = remember { BringIntoViewRequester() }
    var bodyFocused by remember { mutableStateOf(false) }
    val editable = !vm.busy && d.state in setOf(SendState.DRAFT, SendState.FAILED)
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) vm.attach(uri)
        }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = back, enabled = !vm.busy) { Text("‹  返回") }
            Text("写邮件", Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Medium)
            Button(
                onClick = send,
                enabled = editable,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text("发送")
            }
        }
        BoxWithConstraints(Modifier.weight(1f)) {
            val editorHeight = (maxHeight * 0.7f).coerceAtLeast(96.dp)
            LaunchedEffect(d.body, editorHeight, bodyFocused) {
                if (bodyFocused) {
                    withFrameNanos {}
                    bodyRequester.bringIntoView()
                }
            }
            Column(
                Modifier.fillMaxSize().verticalScroll(editorScroll).padding(horizontal = 22.dp)
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
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Text(
                        "发件人  ${vm.account?.email}",
                        Modifier.fillMaxWidth().padding(16.dp),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(8.dp))
                RecipientEditor(vm, d, editable) { subjectRequester.requestFocus() }
                Spacer(Modifier.height(8.dp))
                TextField(
                    value = d.subject,
                    onValueChange = { vm.update(d.copy(subject = it)) },
                    label = { Text("主题") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    keyboardActions =
                        KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }),
                    singleLine = true,
                    readOnly = !editable,
                    modifier = Modifier.fillMaxWidth().focusRequester(subjectRequester),
                    colors = headerFields(),
                    shape = RoundedCornerShape(14.dp),
                )
                Spacer(Modifier.height(8.dp))
                TextField(
                    value = d.body,
                    onValueChange = { vm.update(d.copy(body = it)) },
                    placeholder = { Text("写下想说的话…") },
                    readOnly = !editable,
                    minLines = 3,
                    textStyle = LocalTextStyle.current.copy(fontSize = 16.sp, lineHeight = 28.sp),
                    modifier =
                        Modifier.fillMaxWidth()
                            .heightIn(max = editorHeight)
                            .bringIntoViewRequester(bodyRequester)
                            .onFocusChanged { bodyFocused = it.isFocused }
                            .testTag("compose-body"),
                    colors = paperFields(),
                )
                d.attachments.forEach { attachment ->
                    MailCard(Modifier.padding(vertical = 4.dp)) {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            FileLabel(attachment.name, attachment.size, Modifier.weight(1f))
                            TextButton(
                                onClick = {
                                    vm.update(d.copy(attachments = d.attachments - attachment))
                                },
                                enabled = editable,
                            ) {
                                Text("移除", fontSize = 12.sp)
                            }
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
        unfocusedIndicatorColor = Color.Transparent,
        focusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    )

@Composable
private fun headerFields() =
    TextFieldDefaults.colors(
        focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    )

@Composable
private fun Drafts(vm: MailViewModel) {
    Column(Modifier.fillMaxSize()) {
        Nav("邮箱", { vm.go("boxes") }, !vm.busy)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Heading("草稿与发送记录", vm.account?.email.orEmpty())
                Text(
                    "继续编辑草稿，或查看此设备的发送状态",
                    Modifier.padding(horizontal = 22.dp, vertical = 4.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (vm.drafts.isEmpty()) item { Empty("暂无草稿", "写信时会自动保存，下次打开仍可继续。") }
            items(vm.drafts, key = { it.id }) { d ->
                MailCard(Modifier.padding(horizontal = 22.dp)) {
                    Column(
                        Modifier.fillMaxWidth()
                            .clickable(enabled = !vm.busy) { vm.openDraft(d) }
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Text(
                            d.subject.ifBlank { "（无主题）" },
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            d.to.ifBlank { "尚未填写收件人" },
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (d.body.isNotBlank())
                            Text(
                                d.body.replace('\n', ' '),
                                fontSize = 13.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        val protected = d.state == SendState.UNCERTAIN
                        val tone =
                            if (protected) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.primary
                        Surface(color = tone.copy(alpha = .08f), shape = RoundedCornerShape(6.dp)) {
                            Text(
                                when (d.state) {
                                    SendState.SENT -> "已发送 · 此设备记录"
                                    SendState.UNCERTAIN -> "发送结果待确认 · 请勿重复发送"
                                    SendState.FAILED -> "未提交成功 · 可编辑后重试"
                                    SendState.CONNECTING,
                                    SendState.TRANSMITTING -> "发送中 · 内容已保留"
                                    else -> "草稿 · ${date(d.updated)}"
                                },
                                Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                                fontSize = 12.sp,
                                color = tone,
                            )
                        }
                    }
                }
            }
            item {
                Text(
                    "仅保存在此设备",
                    Modifier.fillMaxWidth().padding(22.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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
                            ServerSummary("收信", imap)
                            ServerSummary("发信", smtp)
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
                colors =
                    ButtonDefaults.buttonColors(
                        disabledContainerColor =
                            if (vm.busy) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurface.copy(alpha = .12f),
                        disabledContentColor =
                            if (vm.busy) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurface.copy(alpha = .38f),
                    ),
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
private fun ServerSummary(label: String, host: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(host, fontSize = 13.sp, modifier = Modifier.weight(1f))
    }
}

private fun pageDepth(page: String): Int =
    when (page) {
        "boxes" -> 0
        "inbox",
        "drafts",
        "settings",
        "add" -> 1
        "reader" -> 2
        "compose" -> 3
        else -> 0
    }

private fun listDate(value: Long): String {
    if (value == 0L) return ""
    val today =
        Calendar.getInstance()
            .apply {
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            .timeInMillis
    return when {
        value >= today -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(value))
        value >= today - 24 * 60 * 60 * 1000L -> "昨天"
        else -> SimpleDateFormat("MM-dd", Locale.getDefault()).format(Date(value))
    }
}
