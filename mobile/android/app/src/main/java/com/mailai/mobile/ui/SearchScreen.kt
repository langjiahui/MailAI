package com.mailai.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mailai.mobile.data.MailItem
import com.mailai.mobile.mail.*
import java.text.SimpleDateFormat
import java.util.*
import kotlinx.coroutines.*

@Composable
internal fun MatchText(
    text: String,
    query: String = "",
    modifier: Modifier = Modifier,
    size: Int = 14,
    weight: FontWeight = FontWeight.Normal,
    color: Color = MaterialTheme.colorScheme.onSurface,
    lines: Int = 1,
) {
    val highlighted =
        remember(text, query) {
            buildAnnotatedString {
                append(text)
                if (query.isNotBlank()) {
                    var start = text.indexOf(query.trim(), ignoreCase = true)
                    while (start >= 0) {
                        addStyle(
                            SpanStyle(background = Color(0xFFFFE6A1), color = Color(0xFF2B2C25)),
                            start,
                            start + query.trim().length,
                        )
                        start =
                            text.indexOf(
                                query.trim(),
                                start + query.trim().length,
                                ignoreCase = true,
                            )
                    }
                }
            }
        }
    Text(
        highlighted,
        modifier,
        fontSize = size.sp,
        fontWeight = weight,
        color = color,
        maxLines = lines,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
internal fun MessageRow(vm: MailViewModel, mail: MailItem, query: String = "") {
    val sender = remember(mail.sender) { MailAddresses.sender(mail.sender).label }
    Row(
        Modifier.fillMaxWidth()
            .clickable(enabled = !vm.busy) { vm.read(mail) }
            .padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ContactAvatar(sender)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MatchText(
                    sender,
                    query,
                    Modifier.weight(1f).padding(end = 6.dp),
                    15,
                    FontWeight.SemiBold,
                )
                Text(
                    mailListDate(mail.date),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            MatchText(
                mail.subject.ifBlank { "（无主题）" },
                query,
                Modifier.padding(top = 4.dp),
                14,
                if (mail.unread) FontWeight.Medium else FontWeight.Normal,
            )
            MatchText(
                mailSnippet(mail.body, query),
                query,
                Modifier.padding(top = 3.dp),
                13,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val files = mail.visibleAttachments()
            if (files.isNotEmpty())
                Row(
                    Modifier.padding(top = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    MailIcon(MailGlyph.Attachment, modifier = Modifier.size(14.dp))
                    MatchText(
                        if (query.isNotBlank())
                            files.firstOrNull { it.name.contains(query, true) }?.name
                                ?: "${files.size} 个附件"
                        else "${files.size} 个附件",
                        query,
                        size = 11,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (mail.unread)
                Box(
                    Modifier.padding(top = 4.dp)
                        .size(7.dp)
                        .background(
                            MaterialTheme.colorScheme.primary,
                            androidx.compose.foundation.shape.CircleShape,
                        )
                )
            IconButton(onClick = { vm.toggleStar(mail) }, modifier = Modifier.size(44.dp)) {
                val starred = mail.key in vm.stars
                MailIcon(
                    MailGlyph.Star,
                    if (starred) "取消星标" else "添加星标",
                    tint = if (starred) Color(0xFFD58C12) else MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

@Composable
internal fun SearchScreen(vm: MailViewModel) {
    var scope by
        androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(SearchScope.ALL) }
    val listState = rememberLazyListState()
    val keyboard = LocalSoftwareKeyboardController.current
    val query = vm.query.trim()
    LaunchedEffect(query, scope) { listState.scrollToItem(0) }
    val source = vm.mails
    val result by
        produceState<Triple<String, List<MailItem>, List<MailItem>>>(
            Triple("", emptyList(), emptyList()),
            vm.query,
            source,
        ) {
            if (query.isBlank()) {
                value = Triple("", source, emptyList())
                return@produceState
            }
            delay(180)
            value =
                Triple(
                    query,
                    source,
                    withContext(Dispatchers.Default) {
                        source.filter {
                            ensureActive()
                            it.matches(query, SearchScope.ALL)
                        }
                    },
                )
        }
    val loading = result.first != query || result.second !== source
    val matches = if (loading) emptyList() else result.third
    fun close() {
        keyboard?.hide()
        vm.query = ""
        vm.go("inbox")
    }
    Column(Modifier.fillMaxSize().testTag("search-page")) {
        PageHeader("搜索结果", ::close) {
            IconButton(onClick = { vm.refresh() }, enabled = !vm.busy) {
                MailIcon(MailGlyph.Refresh, "刷新")
            }
        }
        SearchInput(
            vm.query,
            { vm.query = it },
            "搜索本地邮件",
            Modifier.padding(horizontal = 16.dp, vertical = 6.dp).testTag("mail-search"),
            ::close,
        )
        Row(
            Modifier.horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SearchScope.entries.forEach { item ->
                val count =
                    if (item == SearchScope.ALL) matches.size
                    else matches.count { it.matches(query, item) }
                FilterChip(
                    selected = scope == item,
                    onClick = {
                        scope = item
                        keyboard?.hide()
                    },
                    label = { Text("${item.title} $count") },
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
                    border = null,
                )
            }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
        else Spacer(Modifier.height(2.dp))
        LazyColumn(
            Modifier.weight(1f).testTag("search-results"),
            state = listState,
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (query.isBlank()) item { SearchEmpty("查找邮件", "输入发件人、主题、正文或附件名称。搜索范围为当前文件夹已缓存的邮件。") }
            else if (!loading && matches.isEmpty())
                item {
                    SearchEmpty("没有匹配的邮件", "搜索范围是此设备已缓存的邮件，可换个关键词或刷新收信。")
                    TextButton(onClick = ::close, modifier = Modifier.fillMaxWidth()) {
                        Text("查看全部邮件")
                    }
                }
            else if (scope == SearchScope.ALL) {
                val groups =
                    listOf(
                        "主题" to matches.filter { it.matches(query, SearchScope.SUBJECT) },
                        "发件人" to matches.filter { it.matches(query, SearchScope.SENDER) },
                        "附件" to matches.filter { it.matches(query, SearchScope.ATTACHMENTS) },
                        "正文" to
                            matches.filter { m ->
                                SearchScope.entries
                                    .filterNot { it == SearchScope.ALL }
                                    .none { m.matches(query, it) }
                            },
                    )
                groups
                    .filter { it.second.isNotEmpty() }
                    .forEach { (title, list) ->
                        item(key = title) {
                            MailCard {
                                Row(
                                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        "$title（${list.size}）",
                                        Modifier.weight(1f),
                                        fontSize = 13.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    if (title != "正文" && list.size > 3)
                                        TextButton(
                                            onClick = {
                                                scope =
                                                    SearchScope.entries.first { it.title == title }
                                            }
                                        ) {
                                            Text("查看全部", fontSize = 12.sp)
                                        }
                                }
                                (if (title == "正文") list else list.take(3)).forEachIndexed {
                                    index,
                                    mail ->
                                    if (index > 0)
                                        HorizontalDivider(
                                            Modifier.padding(horizontal = 16.dp),
                                            color = MaterialTheme.colorScheme.outlineVariant,
                                        )
                                    MessageRow(vm, mail, query)
                                }
                            }
                        }
                    }
            } else {
                val list = matches.filter { it.matches(query, scope) }
                if (list.isEmpty() && !loading) item { SearchEmpty("此分类没有匹配结果", "试试其他分类或换个关键词。") }
                items(list, key = { it.key }) { mail -> MailCard { MessageRow(vm, mail, query) } }
            }
        }
    }
}

@Composable
private fun SearchEmpty(title: String, detail: String) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Medium)
        Text(
            detail,
            Modifier.padding(top = 12.dp),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

internal fun mailListDate(value: Long): String =
    if (value <= 0) ""
    else
        SimpleDateFormat(
                if (System.currentTimeMillis() - value < 86400000L) "HH:mm" else "MM-dd",
                Locale.getDefault(),
            )
            .format(Date(value))

internal fun mailSnippet(body: String?, query: String): String {
    if (body == null) return "点开读取正文"
    val match =
        if (query.isBlank()) 0 else body.indexOf(query.trim(), ignoreCase = true).coerceAtLeast(0)
    val start = (match - 24).coerceAtLeast(0)
    return (if (start > 0) "…" else "") +
        body.substring(start, (start + 180).coerceAtMost(body.length)).replace('\n', ' ')
}
