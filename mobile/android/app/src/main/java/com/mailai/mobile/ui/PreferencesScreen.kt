package com.mailai.mobile.ui

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mailai.mobile.BuildConfig
import com.mailai.mobile.MailApplication
import com.mailai.mobile.background.*
import com.mailai.mobile.data.ReadingPreferences
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun PreferencesScreen(vm: MailViewModel) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val reading = remember { ReadingPreferences(context) }
    var originalColors by remember { mutableStateOf(reading.originalColors) }
    var option by rememberSaveable { mutableStateOf("") }
    var showNotifications by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(vm.backgroundRequested) {
        if (vm.backgroundRequested) {
            showNotifications = true
            vm.consumeBackgroundRequest()
        }
    }
    var showUpdates by rememberSaveable { mutableStateOf(vm.updatesRequested) }
    LaunchedEffect(vm.updatesRequested) {
        if (vm.updatesRequested) {
            showUpdates = true
            vm.consumeUpdateRequest()
        }
    }
    var signature by
        rememberSaveable(vm.account?.id) {
            mutableStateOf(reading.signature(vm.account?.id.orEmpty()))
        }
    var cacheRevision by remember { mutableIntStateOf(0) }
    var clearing by remember { mutableStateOf(false) }
    val cacheSize by
        produceState(0L, cacheRevision) {
            value =
                withContext(Dispatchers.IO) {
                    File(context.cacheDir, "mail-images").listFiles().orEmpty().sumOf {
                        if (it.isFile) it.length() else 0
                    }
                }
        }
    val updates = (context.applicationContext as MailApplication).updates
    val state by updates.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, prefs) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        prefs.data.registerOnSharedPreferenceChangeListener(listener)
        reading.data.registerOnSharedPreferenceChangeListener(listener)
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                revision++
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            prefs.data.unregisterOnSharedPreferenceChangeListener(listener)
            reading.data.unregisterOnSharedPreferenceChangeListener(listener)
            owner.lifecycle.removeObserver(observer)
        }
    }
    val notificationEnabled = remember(revision) { MailNotifications.allowed(context) }
    val background = remember(revision) { prefs.background }
    val interval = remember(revision) { prefs.interval }
    val previews = remember(revision) { prefs.previews }
    Column(Modifier.fillMaxSize()) {
        PageHeader("账号与设置", { vm.go(if (vm.accounts.isEmpty()) "add" else "boxes") })
        Column(
            Modifier.weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .testTag("preferences-list")
        ) {
            vm.account?.let { account ->
                MailCard {
                    Row(
                        Modifier.fillMaxWidth().padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ContactAvatar(account.name.ifBlank { account.email }, 44.dp)
                        Column(Modifier.weight(1f)) {
                            Text(account.email, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            Text(
                                account.name.ifBlank { "当前邮箱" },
                                Modifier.padding(top = 4.dp),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { vm.editAccount(account) }, enabled = !vm.busy) {
                            MailIcon(MailGlyph.Chevron, "登录设置", Modifier.size(18.dp))
                        }
                    }
                }
            }
            SectionCaption("小邮")
            MailCard { MenuRow("小邮与模型服务", "按需提炼、回复与润色；无后台自动分析") { vm.openAssistantSettings() } }
            SectionCaption("邮件设置")
            MailCard {
                Box(Modifier.padding(horizontal = 16.dp)) {
                    SettingToggle(
                        "新邮件通知",
                        if (notificationEnabled) "后台定期收信并提醒" else "系统通知未开启，点击下方设置",
                        background,
                        MailGlyph.Bell,
                    ) {
                        prefs.background = it
                        BackgroundSchedule.configure(context)
                        if (it) {
                            BackgroundSchedule.catchUp(context)
                            if (!notificationEnabled) showNotifications = true
                        }
                    }
                }
                SettingsDivider()
                MenuRow(
                    "邮件同步频率",
                    "系统省电时可能延后",
                    if (interval == 60) "1 小时" else "$interval 分钟",
                    icon = MailGlyph.Refresh,
                ) {
                    option = "interval"
                }
                SettingsDivider()
                MenuRow(
                    "默认签名",
                    "仅用于此邮箱的新建、回复与转发",
                    if (reading.signature(vm.account?.id.orEmpty()).isBlank()) "未设置" else "已设置",
                    enabled = vm.account != null,
                    icon = MailGlyph.Pen,
                ) {
                    signature = reading.signature(vm.account?.id.orEmpty())
                    option = "signature"
                }
                SettingsDivider()
                MenuRow("正文字号", "邮件原排版按比例缩放", "${reading.bodySize}", icon = MailGlyph.Font) {
                    option = "font"
                }
                SettingsDivider()
                Box(Modifier.padding(horizontal = 16.dp)) {
                    SettingToggle("保留邮件原始配色", "关闭时，正文中性色跟随深浅外观；图片与强调色保留", originalColors) {
                        originalColors = it
                        reading.originalColors = it
                    }
                }
                SettingsDivider()
                MenuRow("通知与后台运行", "声音、预览、省电设置与最近收信", icon = MailGlyph.Bell) {
                    showNotifications = true
                }
            }
            SectionCaption("通用")
            MailCard {
                MenuRow(
                    "外观",
                    count =
                        when (reading.theme) {
                            "dark" -> "深色"
                            "light" -> "浅色"
                            else -> "跟随系统"
                        },
                    icon = MailGlyph.Moon,
                ) {
                    option = "theme"
                }
                SettingsDivider()
                MenuRow("安全与隐私", "设备存储、链接与通知隐私", icon = MailGlyph.Shield) { option = "privacy" }
                SettingsDivider()
                MenuRow(
                    "清理图片缓存",
                    "不删除邮件、附件或草稿",
                    fileSize(cacheSize),
                    icon = MailGlyph.Trash,
                    enabled = !clearing,
                ) {
                    option = "cache"
                }
            }
            SectionCaption("关于与帮助")
            MailCard {
                MenuRow("版本号", "当前应用版本", BuildConfig.VERSION_NAME, icon = MailGlyph.Info) {
                    showUpdates = !showUpdates
                }
                SettingsDivider()
                MenuRow(
                    "应用更新",
                    if (state.failed) state.message
                    else if (state.ready) "更新已下载，等待安装" else "检查版本与管理下载",
                    icon = MailGlyph.Download,
                ) {
                    showUpdates = !showUpdates
                }
            }
            Text(
                "MailAI · 邮件与草稿保存在这台设备",
                Modifier.padding(vertical = 22.dp).align(Alignment.CenterHorizontally),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    if (showUpdates) AppUpdateSheet(updates, prefs, onDismiss = { showUpdates = false })
    if (showNotifications) {
        BackgroundSettingsSheet(vm.accounts, onDismiss = { showNotifications = false })
    }

    if (option.isNotBlank())
        AlertDialog(
            onDismissRequest = { if (!clearing) option = "" },
            title = {
                Text(
                    when (option) {
                        "interval" -> "邮件同步频率"
                        "font" -> "正文字号"
                        "theme" -> "外观"
                        "signature" -> "默认签名"
                        "cache" -> "清理图片缓存？"
                        else -> "安全与隐私"
                    },
                    fontSize = 18.sp,
                )
            },
            text = {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    when (option) {
                        "interval" ->
                            listOf(15, 30, 60).forEach { value ->
                                PreferenceChoice(
                                    if (value == 60) "1 小时" else "$value 分钟",
                                    interval == value,
                                ) {
                                    prefs.interval = value
                                    BackgroundSchedule.configure(context)
                                    option = ""
                                }
                            }
                        "font" ->
                            listOf(14, 16, 18, 20).forEach { value ->
                                PreferenceChoice("${value} 号", reading.bodySize == value) {
                                    reading.bodySize = value
                                    option = ""
                                }
                            }
                        "theme" ->
                            listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色").forEach {
                                (value, label) ->
                                PreferenceChoice(label, reading.theme == value) {
                                    reading.theme = value
                                    option = ""
                                }
                            }
                        "signature" ->
                            TextField(
                                signature,
                                { signature = it.take(2000) },
                                placeholder = { Text("写下你的邮件签名") },
                                minLines = 3,
                                maxLines = 6,
                                shape = RoundedCornerShape(14.dp),
                                modifier = Modifier.fillMaxWidth().testTag("signature-editor"),
                            )
                        "cache" ->
                            Text(
                                "将清理 ${fileSize(cacheSize)} 的远程图片缓存。邮件正文、内嵌图、下载的附件和草稿都会保留；远程图片之后需联网重新加载。",
                                fontSize = 14.sp,
                            )
                        else ->
                            Text(
                                "邮箱凭据由 Android 密钥库保护。邮件、附件、草稿和通讯录存储在本机。邮件脚本不执行，外部链接确认后再打开。\n\n可在“通知与后台运行”中关闭邮件预览，减少锁屏信息展示。",
                                fontSize = 14.sp,
                            )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        when (option) {
                            "signature" -> {
                                vm.account?.let { reading.signature(it.id, signature.trim()) }
                                vm.showMessage("签名已保存")
                                option = ""
                            }
                            "cache" -> {
                                clearing = true
                                scope.launch {
                                    val success =
                                        withContext(Dispatchers.IO) {
                                            File(context.cacheDir, "mail-images")
                                                .listFiles()
                                                .orEmpty()
                                                .all { !it.isFile || it.delete() }
                                        }
                                    clearing = false
                                    cacheRevision++
                                    option = ""
                                    vm.showMessage(
                                        if (success) "图片缓存已清理" else "部分图片缓存未能清理，请重试",
                                        !success,
                                    )
                                }
                            }
                            else -> option = ""
                        }
                    },
                    enabled = !clearing,
                ) {
                    Text(
                        if (clearing) "正在清理…"
                        else if (option == "signature") "保存"
                        else if (option == "cache") "清理" else "完成"
                    )
                }
            },
            dismissButton = {
                if (option in listOf("signature", "cache"))
                    TextButton(onClick = { option = "" }, enabled = !clearing) { Text("取消") }
            },
        )
}

@Composable
private fun SettingToggle(
    title: String,
    detail: String,
    value: Boolean,
    icon: MailGlyph? = null,
    change: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(value, role = Role.Switch, onValueChange = change),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            MailIcon(icon)
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, fontSize = 15.sp)
            Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = value, onCheckedChange = null)
    }
}

@Composable
private fun SettingsDivider() =
    HorizontalDivider(
        Modifier.padding(start = 54.dp, end = 16.dp),
        color = MaterialTheme.colorScheme.outlineVariant,
    )

@Composable
private fun PreferenceChoice(title: String, selected: Boolean, click: () -> Unit) {
    androidx.compose.material3.Surface(color = androidx.compose.ui.graphics.Color.Transparent) {
        Row(
            Modifier.fillMaxWidth()
                .heightIn(min = 52.dp)
                .selectable(selected, role = Role.RadioButton, onClick = click),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, Modifier.weight(1f), fontSize = 15.sp)
            RadioButton(selected, onClick = null)
        }
    }
}
