package com.mailai.mobile.ui

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mailai.mobile.BuildConfig
import com.mailai.mobile.MailApplication
import com.mailai.mobile.background.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PreferencesScreen(vm: MailViewModel) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val updates = (context.applicationContext as MailApplication).updates
    val state by updates.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var installing by remember { mutableStateOf(false) }
    var installMessage by remember { mutableStateOf("") }
    var showMobileDownload by remember { mutableStateOf(false) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, prefs) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        prefs.data.registerOnSharedPreferenceChangeListener(listener)
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                revision++
                installing = false
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            prefs.data.unregisterOnSharedPreferenceChangeListener(listener)
            owner.lifecycle.removeObserver(observer)
        }
    }
    val notificationEnabled = remember(revision) { MailNotifications.allowed(context) }
    val background = remember(revision) { prefs.background }
    val interval = remember(revision) { prefs.interval }
    val previews = remember(revision) { prefs.previews }
    val autoCheck = remember(revision) { prefs.autoCheck }
    val autoDownload = remember(revision) { prefs.autoDownload }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            revision++
            BackgroundSchedule.catchUp(context)
        }
    fun notificationSettings() {
        context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        )
    }
    fun install() {
        if (!context.packageManager.canRequestPackageInstalls()) {
            installMessage = "请允许 MailAI 安装更新；返回后再次点击安装。"
            context.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                )
            )
            return
        }
        installing = true
        installMessage = "正在核对更新签名…"
        scope.launch {
            try {
                val apk = updates.verifiedApk()
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
                context.startActivity(
                    Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .apply {
                            clipData =
                                android.content.ClipData.newUri(
                                    context.contentResolver,
                                    "MailAI 更新",
                                    uri,
                                )
                        }
                )
                installMessage = "请在系统页面确认安装；取消后可再次安装。"
            } catch (_: Exception) {
                installMessage = "无法安装，请重新下载更新后再试。"
            } finally {
                installing = false
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = { vm.go(if (vm.accounts.isEmpty()) "add" else "boxes") }) {
                Text("‹ 返回")
            }
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column {
                Text("通知与更新", fontSize = 28.sp, fontWeight = FontWeight.Medium)
                Text(
                    "按你的节奏，保持连接",
                    Modifier.padding(top = 8.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SettingsCard("邮件通知") {
                SettingToggle("后台收信", "应用离开前台后，继续定期收取邮件", background) {
                    prefs.background = it
                    BackgroundSchedule.configure(context)
                    if (it) BackgroundSchedule.catchUp(context)
                }
                if (background) {
                    Text(
                        "检查间隔",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 13.sp,
                    )
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(15, 30, 60).forEach { value ->
                            FilterChip(
                                selected = interval == value,
                                onClick = {
                                    prefs.interval = value
                                    BackgroundSchedule.configure(context)
                                },
                                label = { Text(if (value == 60) "1 小时" else "$value 分钟") },
                            )
                        }
                    }
                    Text(
                        if (notificationEnabled) "系统通知已开启" else "系统通知未开启，后台收信仍会继续",
                        fontSize = 13.sp,
                    )
                    if (!notificationEnabled) {
                        Button(
                            onClick = {
                                if (
                                    Build.VERSION.SDK_INT >= 33 &&
                                        androidx.core.content.ContextCompat.checkSelfPermission(
                                            context,
                                            Manifest.permission.POST_NOTIFICATIONS,
                                        ) != android.content.pm.PackageManager.PERMISSION_GRANTED
                                )
                                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                else notificationSettings()
                            }
                        ) {
                            Text("开启邮件通知")
                        }
                    }
                    TextButton(onClick = ::notificationSettings) { Text("通知声音与系统设置") }
                    val power = context.getSystemService(android.os.PowerManager::class.java)
                    val saving = remember(revision) { power.isPowerSaveMode }
                    val optimized =
                        remember(revision) {
                            !power.isIgnoringBatteryOptimizations(context.packageName)
                        }
                    Text(
                        if (saving) "省电模式已开启 · 后台检查可能延迟"
                        else if (optimized) "系统正在优化电池使用 · 长时间锁屏可能延迟收信"
                        else "已允许后台电池使用 · 实际收信时间仍由系统调度",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(
                        onClick = {
                            try {
                                context.startActivity(
                                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                                )
                            } catch (_: android.content.ActivityNotFoundException) {
                                context.startActivity(
                                    Intent(
                                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                        Uri.parse("package:${context.packageName}"),
                                    )
                                )
                            }
                        }
                    ) {
                        Text("后台电池设置")
                    }
                    SettingToggle("显示邮件预览", "通知中显示发件人与主题；锁屏遵循系统隐私设置", previews) { value ->
                        prefs.previews = value
                        if (!value)
                            vm.accounts.forEach { account ->
                                androidx.core.app.NotificationManagerCompat.from(context)
                                    .cancel("mail.${account.id}", 1)
                            }
                    }
                    Text(
                        "锁屏或深度省电时，检查可能延后；返回应用会补查。系统“强行停止”后，需再次打开应用才能恢复。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (vm.accounts.isNotEmpty())
                SettingsCard("最近收信") {
                    vm.accounts.forEach { account ->
                        val time =
                            remember(revision) { prefs.data.getLong("sync.${account.id}.time", 0) }
                        val ok =
                            remember(revision) {
                                prefs.data.getBoolean("sync.${account.id}.ok", true)
                            }
                        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            Text(account.name.ifBlank { account.email }, fontSize = 14.sp)
                            Text(
                                if (time == 0L) "等待首次同步"
                                else "${stamp(time)} · ${if (ok) "已更新" else "连接未成功，稍后重试"}",
                                fontSize = 12.sp,
                                color =
                                    if (ok) MaterialTheme.colorScheme.onSurfaceVariant
                                    else MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            SettingsCard("应用更新") {
                Text(
                    "当前版本 ${BuildConfig.VERSION_NAME}",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SettingToggle("自动检查更新", "每天检查 GitHub 测试通道", autoCheck) {
                    prefs.autoCheck = it
                    BackgroundSchedule.configure(context)
                }
                SettingToggle("Wi-Fi 自动下载", "下载完成后提醒，由你确认安装", autoDownload) {
                    prefs.autoDownload = it
                    BackgroundSchedule.configure(context)
                    if (it) updates.download(true)
                }
                if (state.checking) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.downloading) {
                    LinearProgressIndicator(
                        progress = { state.progress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("${(state.progress * 100).toInt()}%", fontSize = 13.sp)
                }
                if (state.message.isNotBlank())
                    Text(
                        state.message,
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        fontSize = 14.sp,
                        color =
                            if (state.failed) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurface,
                    )
                if (state.checkedAt > 0)
                    Text(
                        "上次检查 ${stamp(state.checkedAt)}",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                state.candidate?.let { candidate ->
                    Text("新版本 ${candidate.version}", fontWeight = FontWeight.Medium)
                    Text(candidate.notes, fontSize = 14.sp)
                    Text(
                        "安装包约 ${candidate.size / 1024 / 1024} MB · 安装会保留邮箱和草稿",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (state.ready) {
                        Button(
                            onClick = ::install,
                            enabled = !installing,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (installing) "正在验证…" else "安装更新")
                        }
                        TextButton(onClick = { updates.download() }, enabled = !state.downloading) {
                            Text("重新验证安装包")
                        }
                    } else if (!state.downloading)
                        Button(
                            onClick = { showMobileDownload = true },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (state.failed) "重新下载" else "下载更新")
                        }
                    TextButton(
                        onClick = {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(candidate.page))
                            )
                        }
                    ) {
                        Text("查看 GitHub 发布说明")
                    }
                }
                if (
                    state.downloading ||
                        state.message.startsWith("等待 Wi-Fi") ||
                        state.message == "正在准备下载…"
                )
                    TextButton(onClick = updates::cancelDownload) { Text("取消下载") }
                TextButton(
                    onClick = updates::checkNow,
                    enabled = !state.checking && !state.downloading,
                ) {
                    Text(if (state.failed && state.candidate == null) "重试检查" else "检查更新")
                }
                if (installMessage.isNotBlank())
                    Text(
                        installMessage,
                        fontSize = 13.sp,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
            }
            Text(
                "测试通道 · 安装包经过完整性、版本及签名验证",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
        }
    }
    if (showMobileDownload)
        AlertDialog(
            onDismissRequest = { showMobileDownload = false },
            title = { Text("下载这次更新？") },
            text = { Text("立即下载会使用当前网络，包括移动数据。你也可以开启 Wi-Fi 自动下载。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showMobileDownload = false
                        updates.download()
                    }
                ) {
                    Text("立即下载")
                }
            },
            dismissButton = { TextButton(onClick = { showMobileDownload = false }) { Text("稍后") } },
        )
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(
            Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.Medium)
            content()
        }
    }
}

@Composable
private fun SettingToggle(
    title: String,
    detail: String,
    value: Boolean,
    change: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 64.dp)
            .toggleable(value, role = Role.Switch, onValueChange = change),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, fontSize = 15.sp)
            Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = value, onCheckedChange = null)
    }
}

private fun stamp(time: Long) =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(time))
