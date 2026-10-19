package com.mailai.mobile.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.data.MailItem
import com.mailai.mobile.mail.MailAddresses
import com.mailai.mobile.mail.MailFilter
import com.mailai.mobile.mail.visibleAttachments
import java.util.Locale

/** Inbox-only presentation. Mail, drafts and the reader keep their existing data paths. */
@Composable
internal fun RefinedInbox(vm: MailViewModel, listState: LazyListState) {
    var previousQuery by rememberSaveable { mutableStateOf(vm.query) }
    var previousFilter by rememberSaveable { mutableStateOf(vm.filter) }
    var previousUnread by rememberSaveable { mutableStateOf(vm.unreadOnly) }
    LaunchedEffect(vm.query, vm.unreadOnly, vm.filter) {
        if (
            previousQuery != vm.query ||
                previousUnread != vm.unreadOnly ||
                previousFilter != vm.filter
        ) {
            previousQuery = vm.query
            previousUnread = vm.unreadOnly
            previousFilter = vm.filter
            listState.scrollToItem(0)
        }
    }
    val ink = MaterialTheme.colorScheme.onSurface
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val paper = MaterialTheme.colorScheme.surface
    val green = MaterialTheme.colorScheme.primary
    val mint = MaterialTheme.colorScheme.primaryContainer
    val compact =
        LocalConfiguration.current.screenWidthDp < 360 || LocalDensity.current.fontScale > 1.3f
    val focus = LocalFocusManager.current
    val density = LocalDensity.current
    val composeDiameter =
        maxOf(64f, 44f + 16f * density.fontScale, 16f + 24f * density.fontScale).dp
    var composeHeight by rememberSaveable { mutableFloatStateOf(composeDiameter.value) }
    val haptic = LocalHapticFeedback.current
    var moreOpen by remember { mutableStateOf(false) }
    val keyboardVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val shortScreen = LocalConfiguration.current.screenHeightDp < 480
    val filtered =
        remember(vm.mails, vm.query, vm.unreadOnly, vm.filter) {
            vm.mails.filter {
                (!vm.unreadOnly || it.unread) &&
                    (when (vm.filter) {
                        MailFilter.STARRED -> it.starred
                        MailFilter.ATTACHMENTS -> it.visibleAttachments().isNotEmpty()
                        else -> true
                    }) &&
                    (vm.query.isBlank() ||
                        (MailAddresses.sender(it.sender).label +
                                it.sender +
                                it.subject +
                                it.body.orEmpty())
                            .contains(vm.query, ignoreCase = true))
            }
        }

    Box(
        Modifier.fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(MaterialTheme.colorScheme.background, paper),
                    endY = with(LocalDensity.current) { 350.dp.toPx() },
                )
            )
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = { vm.go("boxes") },
                    enabled = !vm.busy,
                    modifier = Modifier.semantics { contentDescription = "返回" },
                ) {
                    InboxIcon(InboxGlyph.Back, ink)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (shortScreen) boxName(vm.folder) else "邮箱",
                        color = ink,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 16.sp,
                    )
                }
                Spacer(Modifier.weight(1f))
                val retry = vm.canRetry && (vm.error || vm.status.startsWith("已取消"))
                IconButton(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        if (vm.busy) vm.cancel() else vm.refresh()
                    },
                    enabled = vm.account != null && (!vm.busy || vm.cancellable),
                    modifier =
                        Modifier.semantics {
                            contentDescription =
                                if (vm.busy) "取消同步" else if (retry) "重试同步" else "刷新邮件"
                        },
                ) {
                    if (vm.busy)
                        CircularProgressIndicator(
                            Modifier.size(23.dp),
                            color = green,
                            strokeWidth = 2.dp,
                        )
                    else InboxIcon(InboxGlyph.Refresh, ink)
                }
                Box {
                    IconButton(onClick = { moreOpen = true }, enabled = !vm.busy) {
                        InboxIcon(InboxGlyph.More, ink, "更多选项")
                    }
                    DropdownMenu(
                        expanded = moreOpen,
                        onDismissRequest = { moreOpen = false },
                        shape = RoundedCornerShape(18.dp),
                        containerColor = paper,
                    ) {
                        listOf("通讯录" to "contacts", "草稿与发送记录" to "drafts", "通知与更新" to "settings")
                            .forEach { (title, route) ->
                                DropdownMenuItem(
                                    text = { Text(title) },
                                    onClick = {
                                        moreOpen = false
                                        focus.clearFocus()
                                        vm.go(route)
                                    },
                                )
                            }
                    }
                }
            }
            // Title scrolls away; search stays within thumb reach and never covers the list.
            LazyColumn(
                modifier = Modifier.weight(1f).testTag("inbox-list"),
                state = listState,
                contentPadding =
                    PaddingValues(bottom = if (keyboardVisible) 24.dp else composeHeight.dp + 40.dp),
            ) {
                // Keep the focused search visible when the IME leaves a short viewport.
                if (!keyboardVisible && !shortScreen)
                    item(key = "heading") {
                        Column(
                            Modifier.fillMaxWidth()
                                .padding(horizontal = 22.dp)
                                .padding(top = 12.dp, bottom = 18.dp)
                        ) {
                            Text(
                                if (vm.filter !in listOf(MailFilter.ALL, MailFilter.UNREAD))
                                    vm.filter.title
                                else boxName(vm.folder),
                                fontSize = 30.sp,
                                fontWeight = FontWeight.Bold,
                                color = ink,
                            )
                            Text(
                                vm.account?.email ?: "添加邮箱后即可收发邮件",
                                Modifier.padding(top = 3.dp),
                                color = secondary,
                                fontSize = 14.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                item(key = "search") {
                    InboxSearch(
                        vm.query,
                        vm::changeSearchQuery,
                        if (vm.unreadOnly && vm.filter == MailFilter.ALL) MailFilter.UNREAD
                        else vm.filter,
                        mapOf(
                            MailFilter.ALL to
                                (if (vm.query.isNotBlank()) filtered.size else vm.mails.size),
                            MailFilter.UNREAD to vm.mails.count { it.unread },
                            MailFilter.STARRED to vm.mails.count { it.starred },
                            MailFilter.ATTACHMENTS to
                                vm.mails.count { it.visibleAttachments().isNotEmpty() },
                        ),
                        vm::openFilter,
                        {
                            vm.go("search")
                            if (vm.query.isNotBlank()) vm.searchServer()
                        },
                        compact,
                        paper,
                        ink,
                        secondary,
                        green,
                        mint,
                    )
                    Spacer(Modifier.height(10.dp))
                }
                if (filtered.isEmpty())
                    item(key = "empty") {
                        Column(
                            Modifier.fillMaxWidth().padding(28.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            val searching =
                                vm.query.isNotBlank() ||
                                    vm.unreadOnly ||
                                    vm.filter != MailFilter.ALL
                            Text(
                                when {
                                    vm.query.isNotBlank() -> "没有匹配的邮件"
                                    vm.unreadOnly -> "暂无未读邮件"
                                    vm.filter == MailFilter.STARRED -> "暂无星标邮件"
                                    vm.filter == MailFilter.ATTACHMENTS -> "暂无附件邮件"
                                    vm.busy -> "正在收取邮件…"
                                    else -> "暂无邮件"
                                },
                                color = ink,
                                fontSize = 18.sp,
                            )
                            Text(
                                when {
                                    vm.query.isNotBlank() -> "搜索范围是此设备已缓存的邮件"
                                    vm.unreadOnly -> "可以查看全部邮件，或刷新检查新邮件。"
                                    else -> "刷新收取邮件；离线时可阅读已缓存内容。"
                                },
                                Modifier.padding(top = 10.dp),
                                color = secondary,
                                fontSize = 14.sp,
                            )
                            if (vm.query.isNotBlank())
                                TextButton(
                                    onClick = {
                                        focus.clearFocus()
                                        vm.go("search")
                                        vm.searchServer()
                                    },
                                    enabled = !vm.busy,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Text("搜索整个${boxName(vm.folder)}")
                                }
                            if (searching)
                                TextButton(
                                    onClick = {
                                        vm.openFilter(MailFilter.ALL)
                                        focus.clearFocus()
                                    }
                                ) {
                                    Text("查看全部邮件")
                                }
                            else if (vm.account == null)
                                TextButton(onClick = { vm.go("add") }) { Text("添加邮箱") }
                        }
                    }
                items(filtered, key = { it.key }) { mail ->
                    InboxMailRow(
                        mail,
                        !vm.busy,
                        compact,
                        paper,
                        ink,
                        secondary,
                        green,
                        mail.key !in vm.starPending,
                        { vm.toggleStar(mail) },
                    ) {
                        focus.clearFocus()
                        vm.read(mail)
                    }
                }
                if (vm.query.isBlank() && vm.mails.size >= vm.limit)
                    item(key = "older") {
                        TextButton(
                            onClick = { vm.refresh(true) },
                            enabled = !vm.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("加载更早邮件")
                        }
                    }
            }
        }
        if (!keyboardVisible) {
            Surface(
                onClick = {
                    if (!vm.busy && vm.account != null) {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        vm.compose()
                    }
                },
                enabled = !vm.busy && vm.account != null,
                modifier =
                    Modifier.align(Alignment.BottomEnd)
                        .padding(20.dp)
                        .size(composeDiameter)
                        .onSizeChanged { composeHeight = with(density) { it.height.toDp().value } }
                        .testTag("inbox-compose")
                        .semantics { contentDescription = if (vm.busy) "同步完成后可写信" else "写信" },
                shape = CircleShape,
                shadowElevation = 4.dp,
                color = if (!vm.busy && vm.account != null) green else mint,
                contentColor =
                    if (!vm.busy && vm.account != null) MaterialTheme.colorScheme.onPrimary
                    else secondary,
            ) {
                Column(
                    Modifier.fillMaxSize().padding(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
                ) {
                    InboxIcon(
                        InboxGlyph.Compose,
                        if (!vm.busy && vm.account != null) MaterialTheme.colorScheme.onPrimary
                        else secondary,
                    )
                    Text(
                        "写信",
                        fontSize = 12.sp,
                        lineHeight = 16.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun InboxSearch(
    query: String,
    onQuery: (String) -> Unit,
    filter: MailFilter,
    counts: Map<MailFilter, Int>,
    onFilter: (MailFilter) -> Unit,
    onSearch: () -> Unit,
    compact: Boolean,
    paper: Color,
    ink: Color,
    secondary: Color,
    green: Color,
    mint: Color,
) {
    var expanded by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val haptic = LocalHapticFeedback.current
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 4.dp),
        shape = RoundedCornerShape(30.dp),
        color = paper,
        shadowElevation = 2.dp,
    ) {
        Column(Modifier.padding(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onSearch, modifier = Modifier.testTag("open-search")) {
                    InboxIcon(InboxGlyph.Search, secondary, "分类搜索")
                }
                BasicTextField(
                    query,
                    onQuery,
                    modifier =
                        Modifier.weight(1f).heightIn(min = 44.dp).testTag("mail-search").semantics {
                            contentDescription = "搜索本地邮件"
                        },
                    singleLine = true,
                    textStyle = TextStyle(color = ink, fontSize = 14.sp),
                    cursorBrush = SolidColor(green),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions =
                        KeyboardActions(
                            onSearch = {
                                focus.clearFocus()
                                onSearch()
                            }
                        ),
                    decorationBox = { field ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (query.isEmpty())
                                Text(
                                    if (compact) "搜索邮件" else "搜索邮件（发件人、主题）",
                                    color = secondary,
                                    fontSize = 14.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            field()
                        }
                    },
                )
                if (query.isNotEmpty())
                    IconButton(onClick = { onQuery("") }) {
                        InboxIcon(InboxGlyph.Close, secondary, "清除")
                    }
                if (!compact) {
                    Box(Modifier.width(1.dp).height(22.dp).background(secondary.copy(alpha = .16f)))
                    InboxFilter(
                        filter,
                        counts,
                        expanded,
                        { expanded = it },
                        {
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            onFilter(it)
                        },
                        paper,
                        ink,
                        green,
                        mint,
                    )
                }
            }
            if (compact) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    InboxFilter(
                        filter,
                        counts,
                        expanded,
                        { expanded = it },
                        {
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            onFilter(it)
                        },
                        paper,
                        ink,
                        green,
                        mint,
                    )
                }
            }
        }
    }
}

@Composable
private fun InboxFilter(
    filter: MailFilter,
    counts: Map<MailFilter, Int>,
    expanded: Boolean,
    onExpanded: (Boolean) -> Unit,
    onFilter: (MailFilter) -> Unit,
    paper: Color,
    ink: Color,
    green: Color,
    mint: Color,
) {
    Box(Modifier.padding(start = 6.dp)) {
        Surface(
            onClick = { onExpanded(true) },
            color = mint,
            shape = RoundedCornerShape(24.dp),
            modifier =
                Modifier.testTag("inbox-filter").semantics {
                    contentDescription = "筛选邮件，${filter.title} ${counts[filter] ?: 0} 封，当前已缓存"
                },
        ) {
            Row(
                Modifier.heightIn(min = 44.dp).padding(horizontal = 12.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (filter == MailFilter.STARRED) "星标"
                    else if (filter == MailFilter.ATTACHMENTS) "附件" else filter.title,
                    color = green,
                    fontSize = 14.sp,
                )
                Text((counts[filter] ?: 0).toString(), color = green, fontSize = 14.sp)
                InboxIcon(InboxGlyph.Down, green, modifier = Modifier.size(18.dp))
            }
        }
        DropdownMenu(
            expanded,
            { onExpanded(false) },
            shape = RoundedCornerShape(20.dp),
            containerColor = paper,
        ) {
            MailFilter.entries.forEach { item ->
                val count = counts[item] ?: 0
                val selected = item == filter
                val fill by
                    animateColorAsState(
                        if (selected) mint else Color.Transparent,
                        tween(140),
                        label = "邮件筛选",
                    )
                DropdownMenuItem(
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(24.dp),
                        ) {
                            Text(item.title)
                            Text(count.toString())
                        }
                    },
                    onClick = {
                        onFilter(item)
                        onExpanded(false)
                    },
                    modifier =
                        Modifier.padding(horizontal = 6.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(fill)
                            .testTag("filter-${item.name.lowercase(Locale.ROOT)}"),
                    leadingIcon = {
                        if (selected) InboxIcon(InboxGlyph.Check, green)
                        else Spacer(Modifier.size(24.dp))
                    },
                    colors = MenuDefaults.itemColors(textColor = if (selected) green else ink),
                )
            }
        }
    }
}

@Composable
private fun InboxMailRow(
    mail: MailItem,
    enabled: Boolean,
    compact: Boolean,
    paper: Color,
    ink: Color,
    secondary: Color,
    green: Color,
    starEnabled: Boolean,
    onStar: () -> Unit,
    onClick: () -> Unit,
) {
    val sender = remember(mail.sender) { MailAddresses.sender(mail.sender) }
    val label = sender.label.ifBlank { "未知发件人" }
    val preview = remember(mail.body) { mail.body?.replace(Regex("\\s+"), " ")?.trim().orEmpty() }
    Row(
        Modifier.fillMaxWidth()
            .background(paper)
            .clickable(enabled = enabled, onClick = onClick)
            .testTag("inbox-mail-${mail.key}")
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp),
    ) {
        InboxAvatar(label, sender.email.ifBlank { label }, compact)
        Box(Modifier.weight(1f)) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        label,
                        Modifier.weight(1f),
                        color = ink,
                        fontSize = 16.sp,
                        lineHeight = 20.sp,
                        fontWeight = if (mail.unread) FontWeight.Bold else FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        listDate(mail.date),
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = secondary,
                        maxLines = 1,
                    )
                    if (mail.unread)
                        Box(
                            Modifier.size(7.dp).clip(CircleShape).background(green).semantics {
                                contentDescription = "未读"
                            }
                        )
                }
                Text(
                    mail.subject.ifBlank { "（无主题）" },
                    Modifier.padding(end = 40.dp),
                    color = ink,
                    fontSize = 14.sp,
                    lineHeight = 19.sp,
                    maxLines = if (compact) 2 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    preview.ifBlank { "点开读取正文" },
                    Modifier.padding(end = 40.dp),
                    color = secondary,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (mail.visibleAttachments().isNotEmpty())
                    Row(
                        Modifier.padding(end = 40.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        InboxIcon(InboxGlyph.Attachment, secondary, modifier = Modifier.size(16.dp))
                        Text(
                            "${mail.visibleAttachments().size} 个附件",
                            color = secondary,
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                        )
                    }
            }
            // The full-size touch target overlays reserved trailing space, adding no extra row.
            Box(Modifier.matchParentSize(), contentAlignment = Alignment.BottomEnd) {
                IconToggleButton(
                    checked = mail.starred,
                    onCheckedChange = { onStar() },
                    enabled = enabled && starEnabled,
                    modifier =
                        Modifier.size(48.dp).semantics {
                            contentDescription = if (mail.starred) "取消星标（此设备）" else "标记星标（此设备）"
                        },
                ) {
                    InboxIcon(
                        if (mail.starred) InboxGlyph.StarFilled else InboxGlyph.Star,
                        if (mail.starred) green else secondary,
                    )
                }
            }
        }
    }
}

@Composable
private fun InboxAvatar(label: String, key: String, compact: Boolean) {
    ContactAvatar(label, if (compact) 36.dp else 44.dp)
}

/** Small native strokes; no decorative AI glyphs or extra icon dependency. */
private enum class InboxGlyph {
    Star,
    StarFilled,
    Back,
    Refresh,
    More,
    Search,
    Down,
    Check,
    Close,
    Compose,
    Attachment,
}

@Composable
private fun InboxIcon(
    glyph: InboxGlyph,
    color: Color,
    description: String? = null,
    modifier: Modifier = Modifier,
) {
    Canvas(
        modifier
            .size(24.dp)
            .then(
                if (description == null) Modifier
                else Modifier.semantics { contentDescription = description }
            )
    ) {
        val unit = minOf(size.width, size.height) / 24f
        withTransform({
            translate((size.width - unit * 24f) / 2f, (size.height - unit * 24f) / 2f)
            scale(unit, unit, pivot = androidx.compose.ui.geometry.Offset.Zero)
        }) {
            val stroke = Stroke(1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
            val path = Path()
            when (glyph) {
                InboxGlyph.Star,
                InboxGlyph.StarFilled -> {
                    for (i in 0 until 10) {
                        val angle = -Math.PI / 2 + i * Math.PI / 5
                        val radius = if (i % 2 == 0) 10f else 4.8f
                        val x = 12f + kotlin.math.cos(angle).toFloat() * radius
                        val y = 12f + kotlin.math.sin(angle).toFloat() * radius
                        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    path.close()
                    if (glyph == InboxGlyph.StarFilled) drawPath(path, color)
                }
                InboxGlyph.Back -> {
                    path.moveTo(15f, 4f)
                    path.lineTo(7f, 12f)
                    path.lineTo(15f, 20f)
                }
                InboxGlyph.Down -> {
                    path.moveTo(5f, 9f)
                    path.lineTo(12f, 16f)
                    path.lineTo(19f, 9f)
                }
                InboxGlyph.Check -> {
                    path.moveTo(4f, 12f)
                    path.lineTo(9f, 17f)
                    path.lineTo(20f, 6f)
                }
                InboxGlyph.Close -> {
                    path.moveTo(6f, 6f)
                    path.lineTo(18f, 18f)
                    path.moveTo(18f, 6f)
                    path.lineTo(6f, 18f)
                }
                InboxGlyph.More ->
                    listOf(5f, 12f, 19f).forEach {
                        drawCircle(color, 1.7f, androidx.compose.ui.geometry.Offset(it, 12f))
                    }
                InboxGlyph.Search -> {
                    drawCircle(
                        color,
                        7f,
                        androidx.compose.ui.geometry.Offset(10f, 10f),
                        style = stroke,
                    )
                    path.moveTo(15.5f, 15.5f)
                    path.lineTo(21f, 21f)
                }
                InboxGlyph.Refresh -> {
                    path.moveTo(20f, 8f)
                    path.cubicTo(17f, 1f, 5f, 2f, 3f, 10f)
                    path.cubicTo(0f, 22f, 18f, 25f, 21f, 14f)
                    path.moveTo(20f, 3f)
                    path.lineTo(20f, 8f)
                    path.lineTo(15f, 8f)
                }
                InboxGlyph.Compose -> {
                    path.moveTo(12f, 4f)
                    path.lineTo(5f, 4f)
                    path.quadraticTo(3f, 4f, 3f, 6f)
                    path.lineTo(3f, 19f)
                    path.quadraticTo(3f, 21f, 5f, 21f)
                    path.lineTo(18f, 21f)
                    path.quadraticTo(20f, 21f, 20f, 19f)
                    path.lineTo(20f, 12f)
                    path.moveTo(10f, 14f)
                    path.lineTo(11f, 10f)
                    path.lineTo(19f, 2f)
                    path.lineTo(22f, 5f)
                    path.lineTo(14f, 13f)
                    path.close()
                }
                InboxGlyph.Attachment -> {
                    path.moveTo(8f, 13f)
                    path.lineTo(15f, 6f)
                    path.cubicTo(18f, 3f, 22f, 7f, 19f, 10f)
                    path.lineTo(10f, 19f)
                    path.cubicTo(5f, 24f, -1f, 17f, 4f, 12f)
                    path.lineTo(13f, 3f)
                    path.cubicTo(17f, -1f, 23f, 1f, 23f, 6f)
                }
            }
            drawPath(path, color, style = stroke)
        }
    }
}
