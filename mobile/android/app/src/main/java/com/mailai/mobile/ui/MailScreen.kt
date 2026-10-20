package com.mailai.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
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
import com.mailai.mobile.mail.*
import java.text.SimpleDateFormat
import java.util.*

private val Light =
    lightColorScheme(
        primary = Color(0xFF005D46),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFDFF2E9),
        onPrimaryContainer = Color(0xFF243226),
        secondary = Color(0xFF55624F),
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFEAF5EF),
        onSecondaryContainer = Color(0xFF005D46),
        outline = Color(0xFF788273),
        background = Color(0xFFF3F8FB),
        onBackground = Color(0xFF14243B),
        surface = Color.White,
        surfaceVariant = Color(0xFFECF2F6),
        surfaceContainerHighest = Color(0xFFE5E8E1),
        surfaceContainer = Color(0xFFECF2F6),
        surfaceContainerHigh = Color(0xFFE8EEF3),
        surfaceContainerLow = Color(0xFFF1F6F9),
        surfaceTint = Color(0xFF005D46),
        onSurface = Color(0xFF14243B),
        onSurfaceVariant = Color(0xFF627287),
        outlineVariant = Color(0xFFE8EEF3),
    )
private val Dark =
    darkColorScheme(
        primary = Color(0xFFC5D4BD),
        onPrimary = Color(0xFF20271D),
        primaryContainer = Color(0xFF005D46),
        onPrimaryContainer = Color(0xFFC5D4BD),
        secondary = Color(0xFFB7C7AF),
        onSecondary = Color(0xFF20301F),
        secondaryContainer = Color(0xFF005D46),
        onSecondaryContainer = Color(0xFFDAE5D2),
        outline = Color(0xFF788273),
        background = Color(0xFF131A17),
        onBackground = Color(0xFFECEEE7),
        surface = Color(0xFF1D2722),
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
    val context = androidx.compose.ui.platform.LocalContext.current
    val reading = remember { ReadingPreferences(context) }
    var theme by remember { mutableStateOf(reading.theme) }
    DisposableEffect(reading) {
        val listener =
            android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
                theme = reading.theme
            }
        reading.data.registerOnSharedPreferenceChangeListener(listener)
        onDispose { reading.data.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val dark =
        when (theme) {
            "dark" -> true
            "light" -> false
            else -> isSystemInDarkTheme()
        }
    MaterialTheme(colorScheme = if (dark) Dark else Light) {
        MailSystemBars()
        NotificationPermissionEffect(vm)
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
                "reader" -> vm.go(vm.readerOrigin)
                "assistant-settings" -> vm.closeAssistantSettings()
                "search" -> {
                    vm.query = ""
                    vm.go("inbox")
                }
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
                                        "assistant-settings" -> AssistantSettingsScreen(vm)
                                        "contacts" -> ContactsScreen(vm)
                                        "search" -> SearchScreen(vm)
                                        else -> RefinedInbox(vm, inboxList)
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
            androidx.compose.ui.window.Dialog(onDismissRequest = { leave = false }) {
                Surface(
                    shape = RoundedCornerShape(24.dp),
                    color = MaterialTheme.colorScheme.surface,
                    tonalElevation = 0.dp,
                ) {
                    Column(
                        Modifier.fillMaxWidth()
                            .heightIn(max = 540.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(22.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("保留这封草稿？", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "正文和附件会保存在这台手机，稍后可继续编辑。",
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = {
                                leave = false
                                vm.saveAndLeave()
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            shape = RoundedCornerShape(14.dp),
                        ) {
                            Text("保存并返回")
                        }
                        TextButton(
                            onClick = { leave = false },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Text("继续编辑")
                        }
                        TextButton(
                            onClick = {
                                leave = false
                                vm.discard()
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Text("放弃草稿", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        AssistantSheet(vm)
        if (confirmSend)
            AlertDialog(
                onDismissRequest = { confirmSend = false },
                title = { Text("发送这封邮件？") },
                text = {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        Text("发件人：${vm.account?.email}")
                        Spacer(Modifier.height(12.dp))
                        Text("收件人：${vm.draft?.to}")
                        vm.draft?.cc?.takeIf { it.isNotBlank() }?.let { Text("抄送：$it") }
                        vm.draft?.bcc?.takeIf { it.isNotBlank() }?.let { Text("密送：$it（其他收件人不可见）") }
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
        TextButton(
            onClick = back,
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "返回" },
        ) {
            Text("‹  $label")
        }
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

internal fun boxName(value: String) =
    when (value.lowercase(Locale.ROOT)) {
        "inbox" -> "收件箱"
        "sent",
        "sent items",
        "sent messages" -> "已发送"
        "drafts" -> "草稿箱"
        "trash",
        "deleted items",
        "deleted messages" -> "已删除"
        "archive",
        "archives" -> "已归档"
        "junk",
        "spam" -> "垃圾邮件"
        else -> value
    }

@Composable
private fun Mailboxes(vm: MailViewModel) {
    Column(Modifier.fillMaxSize()) {
        PageHeader("邮箱文件夹", { vm.go("inbox") }) {
            TextButton(onClick = { vm.go("add") }, enabled = !vm.busy) {
                Text("添加邮箱", fontSize = 13.sp)
            }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            MailCard {
                vm.accounts.forEachIndexed { i, a ->
                    if (i > 0)
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
            MailCard {
                Column(Modifier.padding(6.dp)) {
                    MenuRow(
                        "收件箱",
                        count =
                            if (vm.folder.equals("INBOX", true)) vm.mails.size.toString() else "",
                        icon = MailGlyph.Inbox,
                        selected = vm.filter == MailFilter.ALL && vm.folder.equals("INBOX", true),
                        enabled = !vm.busy,
                    ) {
                        vm.account?.let { vm.choose(it) }
                        vm.openFilter(MailFilter.ALL)
                    }
                    MenuRow(
                        "未读",
                        count = vm.mails.count { it.unread }.toString(),
                        icon = MailGlyph.Mail,
                        enabled = !vm.busy,
                    ) {
                        vm.openFilter(MailFilter.UNREAD)
                    }
                    MenuRow(
                        "星标邮件",
                        count = vm.mails.count { it.key in vm.stars }.toString(),
                        icon = MailGlyph.Star,
                        enabled = !vm.busy,
                    ) {
                        vm.openFilter(MailFilter.STARRED)
                    }
                    MenuRow(
                        "附件邮件",
                        count = vm.mails.count { it.visibleAttachments().isNotEmpty() }.toString(),
                        icon = MailGlyph.Attachment,
                        enabled = !vm.busy,
                    ) {
                        vm.openFilter(MailFilter.ATTACHMENTS)
                    }
                    HorizontalDivider(
                        Modifier.padding(horizontal = 12.dp),
                        color = MaterialTheme.colorScheme.outlineVariant,
                    )
                    MenuRow(
                        "草稿与发送记录",
                        "保存在此设备",
                        vm.drafts.size.toString(),
                        !vm.busy,
                        icon = MailGlyph.Draft,
                    ) {
                        vm.go("drafts")
                    }
                    vm.folders
                        .filterNot { it.equals("INBOX", true) }
                        .forEach { folder ->
                            MenuRow(boxName(folder), icon = MailGlyph.Folder, enabled = !vm.busy) {
                                vm.account?.let { vm.choose(it, folder) }
                            }
                        }
                }
            }
            Text(
                "未读、星标与附件数量基于当前文件夹的本地缓存",
                Modifier.padding(horizontal = 4.dp),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            MailCard {
                MenuRow("通讯录", "往来联系人与手机通讯录", icon = MailGlyph.Contacts) { vm.go("contacts") }
                HorizontalDivider(
                    Modifier.padding(horizontal = 16.dp),
                    color = MaterialTheme.colorScheme.outlineVariant,
                )
                MenuRow("账号与设置", icon = MailGlyph.Settings) { vm.go("settings") }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Reader(vm: MailViewModel, back: () -> Unit) {
    var lastMail by remember { mutableStateOf(vm.selected) }
    val m = vm.selected ?: lastMail ?: return
    SideEffect { if (vm.selected != null) lastMail = vm.selected }
    val readingScroll = rememberSaveable(m.key, saver = ScrollState.Saver) { ScrollState(0) }
    var details by remember(m.key) { mutableStateOf(false) }
    var attachmentList by remember(m.key) { mutableStateOf(false) }
    var link by remember { mutableStateOf<String?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val sender = remember(m.sender) { MailAddresses.sender(m.sender) }
    val files =
        m.attachments.filter {
            it.contentId.isBlank() || !it.type.startsWith("image/", true) || it.local.isBlank()
        }
    if (details) MailPeopleDialog(vm, m) { details = false }
    if (attachmentList)
        MailBottomSheet(title = "附件 · ${files.size}", onDismiss = { attachmentList = false }) {
            Column(Modifier.fillMaxWidth().testTag("attachment-sheet")) {
                LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
                    items(files, key = { it.part }) { file ->
                        Surface(
                            onClick = {
                                attachmentList = false
                                vm.download(file)
                            },
                            enabled = !vm.busy,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        ) {
                            Row(
                                Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                FileLabel(file.name, file.size, Modifier.weight(1f))
                                MailIcon(
                                    if (file.local.isBlank()) MailGlyph.Download
                                    else MailGlyph.Chevron,
                                    if (file.local.isBlank()) "下载" else "打开",
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                }
            }
        }
    link?.let { url ->
        AlertDialog(
            onDismissRequest = { link = null },
            title = { Text("打开链接？", fontSize = 18.sp) },
            text = {
                Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
                    SelectionContainer { Text(url, fontSize = 14.sp, lineHeight = 22.sp) }
                }
            },
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
    val reading = remember { ReadingPreferences(context) }
    Column(Modifier.fillMaxSize()) {
        PageHeader("邮件详情", back) {
            XiaoyouButton(vm)
            if (androidx.compose.ui.platform.LocalDensity.current.fontScale <= 1.5f)
                IconButton(onClick = { vm.toggleStar(m) }) {
                    MailIcon(
                        MailGlyph.Star,
                        if (m.key in vm.stars) "取消星标" else "添加星标",
                        tint =
                            if (m.key in vm.stars) Color(0xFFD58C12)
                            else MaterialTheme.colorScheme.onSurface,
                    )
                }
            IconButton(onClick = { details = true }) {
                MailIcon(MailGlyph.More, "详情", tint = MaterialTheme.colorScheme.onSurface)
            }
        }
        Surface(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp),
            color = MaterialTheme.colorScheme.surface,
            shape = RoundedCornerShape(20.dp),
        ) {
            BoxWithConstraints {
                val compactHeader =
                    androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.5f
                val headerHeight = maxHeight * .45f
                Column(Modifier.fillMaxSize()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .heightIn(max = headerHeight)
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp)
                    ) {
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable { details = true }
                                .padding(
                                    top = if (compactHeader) 8.dp else 14.dp,
                                    bottom = if (compactHeader) 6.dp else 10.dp,
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            ContactAvatar(sender.label)
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        sender.label,
                                        Modifier.weight(1f),
                                        fontSize = if (compactHeader) 14.sp else 15.sp,
                                        lineHeight = if (compactHeader) 18.sp else 20.sp,
                                        fontWeight = FontWeight.SemiBold,
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
                                Text(
                                    if (compactHeader)
                                        peopleSummary(m, vm.account?.email.orEmpty()) + "  ›"
                                    else sender.email,
                                    Modifier.padding(top = 3.dp),
                                    fontSize = if (compactHeader) 11.sp else 12.sp,
                                    lineHeight = if (compactHeader) 14.sp else 18.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            MailIcon(MailGlyph.Expand, modifier = Modifier.size(18.dp))
                        }
                        if (!compactHeader)
                            Text(
                                peopleSummary(m, vm.account?.email.orEmpty()) + "  ›",
                                Modifier.fillMaxWidth()
                                    .clickable { details = true }
                                    .padding(bottom = 10.dp),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Text(
                            m.subject,
                            Modifier.clickable { details = true }
                                .padding(
                                    top = if (compactHeader) 8.dp else 12.dp,
                                    bottom = if (compactHeader) 6.dp else 8.dp,
                                ),
                            fontSize = if (compactHeader) 16.sp else 20.sp,
                            lineHeight = if (compactHeader) 20.sp else 28.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = if (compactHeader) 1 else 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (m.html != null)
                        HtmlMailBody(
                            vm,
                            m,
                            Modifier.fillMaxWidth().weight(1f),
                            onLink = { link = it },
                        )
                    else
                        Column(
                            Modifier.fillMaxWidth()
                                .weight(1f)
                                .verticalScroll(readingScroll)
                                .padding(horizontal = 16.dp, vertical = 12.dp)
                        ) {
                            SelectionContainer {
                                Text(
                                    m.body ?: if (vm.busy) "正在读取正文…" else "正文未下载，请联网后重试。",
                                    fontSize = reading.bodySize.sp,
                                    lineHeight = (reading.bodySize + 10).sp,
                                )
                            }
                            if (!vm.busy && (m.body == null || m.contentVersion == 0 || vm.error))
                                TextButton(onClick = { vm.fetchBody(true) }) {
                                    Text(if (vm.error) "重试读取" else "重新读取原邮件")
                                }
                        }
                    if (vm.canRetry && vm.error && m.html != null)
                        TextButton(onClick = vm::retry, enabled = !vm.busy) { Text("重试读取") }
                    if (files.isNotEmpty())
                        Surface(
                            onClick = { attachmentList = true },
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                MailIcon(MailGlyph.Attachment, modifier = Modifier.size(18.dp))
                                Text("附件 ${files.size}", fontSize = 13.sp)
                                Text(
                                    files.first().name,
                                    Modifier.weight(1f),
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                MailIcon(MailGlyph.Chevron, modifier = Modifier.size(16.dp))
                            }
                        }
                }
            }
        }
        Surface(
            Modifier.fillMaxWidth().padding(8.dp),
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Row(
                Modifier.padding(5.dp).height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                listOf(
                        Triple("回复", MailGlyph.Reply, { vm.compose(true) }),
                        Triple("回复全部", MailGlyph.ReplyAll, { vm.compose(true, replyAll = true) }),
                        Triple("转发", MailGlyph.Forward, { vm.compose(forward = true) }),
                    )
                    .forEach { (title, glyph, action) ->
                        FilledTonalButton(
                            onClick = action,
                            enabled = !vm.busy && m.body != null,
                            shape = RoundedCornerShape(24.dp),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 10.dp),
                            modifier = Modifier.weight(1f).fillMaxHeight().heightIn(min = 48.dp),
                        ) {
                            if (
                                androidx.compose.ui.platform.LocalDensity.current.fontScale <= 1.1f
                            ) {
                                MailIcon(
                                    glyph,
                                    modifier = Modifier.size(18.dp),
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                                Spacer(Modifier.width(5.dp))
                            }
                            Text(
                                title,
                                fontSize = 13.sp,
                                lineHeight = 18.sp,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                        }
                    }
            }
        }
    }
}

@Composable
private fun Composer(vm: MailViewModel, back: () -> Unit, send: () -> Unit) {
    ComposeEditor(vm, back, send)
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
private fun Drafts(vm: MailViewModel) {
    Column(Modifier.fillMaxSize()) {
        PageHeader("草稿与发送记录", { vm.go("boxes") })
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(
                    vm.account?.email.orEmpty(),
                    Modifier.padding(horizontal = 22.dp),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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
            PageHeader(if (editing == null) "添加邮箱" else "邮箱登录设置", back)
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
        "reader",
        "search" -> 2
        "compose" -> 3
        "assistant-settings" -> 4
        else -> 0
    }

internal fun listDate(value: Long): String {
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
