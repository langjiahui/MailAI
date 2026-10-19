package com.mailai.mobile.ui

import android.Manifest
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.mailai.mobile.background.*
import com.mailai.mobile.data.Account
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Ask once, after an inbox is usable. Denial never prevents mail use or triggers repeated prompts.
 */
@Composable
internal fun NotificationPermissionEffect(vm: MailViewModel) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val launcher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            if (it) BackgroundSchedule.catchUp(context)
        }
    LaunchedEffect(vm.ready, vm.accounts.isNotEmpty(), vm.page, vm.busy) {
        if (
            Build.VERSION.SDK_INT >= 33 &&
                vm.ready &&
                vm.accounts.isNotEmpty() &&
                vm.page == "inbox" &&
                !vm.busy &&
                prefs.background &&
                !prefs.notificationPrompted
        ) {
            prefs.notificationPrompted = true
            if (
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
            )
                launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun BackgroundSettingsSheet(accounts: List<Account>, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { AppPreferences(context) }
    val health = remember { BackgroundHealth(context) }
    var revision by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, prefs) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        val data =
            context.getSharedPreferences(
                "mailai.background-health",
                android.content.Context.MODE_PRIVATE,
            )
        prefs.data.registerOnSharedPreferenceChangeListener(listener)
        data.registerOnSharedPreferenceChangeListener(listener)
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) revision++
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            prefs.data.unregisterOnSharedPreferenceChangeListener(listener)
            data.unregisterOnSharedPreferenceChangeListener(listener)
            owner.lifecycle.removeObserver(observer)
        }
    }
    val allowed = remember(revision) { MailNotifications.allowed(context) }
    val access = remember(revision) { BackgroundAccess.state(context) }
    val work =
        remember { WorkManager.getInstance(context).getWorkInfosForUniqueWorkFlow("mail-catch-up") }
            .collectAsStateWithLifecycle(initialValue = emptyList())
            .value
    val pending = work.any { !it.state.isFinished }
    val running = work.any { it.state == WorkInfo.State.RUNNING }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            revision++
            if (it) BackgroundSchedule.catchUp(context)
        }
    fun feedback(message: String) {
        android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()
    }
    fun open(destination: String) {
        if (!BackgroundAccess.open(context, destination)) feedback("系统设置暂时打不开，请从手机设置进入 MailAI 应用信息")
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        contentWindowInsets = { WindowInsets.safeDrawing },
        containerColor = MaterialTheme.colorScheme.surface,
        dragHandle = null,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.94f).testTag("background-settings")) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "后台收信",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                TextButton(onClick = onDismiss) { Text("完成") }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Column(
                Modifier.weight(1f)
                    .clipToBounds()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("静默收信，按需提醒", style = MaterialTheme.typography.titleMedium)
                Text(
                    "后台只检查邮件列表，不自动下载正文与附件，也不调用小邮。检查结束即断开，不显示常驻通知。",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("后台收信", Modifier.weight(1f))
                    Switch(
                        checked = prefs.background,
                        onCheckedChange = {
                            prefs.background = it
                            BackgroundSchedule.configure(context)
                            if (it) BackgroundSchedule.catchUp(context)
                        },
                    )
                }
                if (prefs.background) {
                    Text("检查间隔 · 深度休眠时可能延后", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(15, 30, 60).forEach { value ->
                            FilterChip(
                                prefs.interval == value,
                                onClick = {
                                    prefs.interval = value
                                    BackgroundSchedule.configure(context)
                                },
                                label = { Text(if (value == 60) "1 小时" else "$value 分钟") },
                            )
                        }
                    }
                }
                HorizontalDivider()
                Text(if (allowed) "邮件通知已允许" else "邮件通知未允许", fontWeight = FontWeight.Medium)
                if (!allowed) {
                    Text("可以收信，但系统不会显示邮件提醒。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(
                        onClick = {
                            if (
                                Build.VERSION.SDK_INT >= 33 &&
                                    ContextCompat.checkSelfPermission(
                                        context,
                                        Manifest.permission.POST_NOTIFICATIONS,
                                    ) != PackageManager.PERMISSION_GRANTED
                            ) {
                                prefs.notificationPrompted = true
                                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            } else open("notifications")
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("开启邮件通知")
                    }
                }
                OutlinedButton(
                    onClick = {
                        feedback(
                            if (MailNotifications.test(context)) "测试通知已交给系统，请下拉通知栏查看"
                            else "请先允许邮件通知，并开启新邮件通知类别"
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("发送一条测试通知")
                }
                Text(
                    "此测试只检查通知显示，锁屏后台收信请看下方记录。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { open("notifications") }) { Text("声音、锁屏与通知类别") }
                HorizontalDivider()
                Text(
                    if (BackgroundAccess.xiaomi) "小米 / 澎湃 OS 后台设置" else "后台运行设置",
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    when {
                        access.restricted -> "系统已限制后台运行，可能只能打开应用后收信。"
                        access.saving -> "手机处于省电模式，后台检查可能推迟。"
                        access.optimized -> "系统正在优化电池使用，长时间锁屏后检查可能推迟。"
                        else -> "Android 电池优化已放行，收信时间仍由系统调度。"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (BackgroundAccess.xiaomi) {
                    Text(
                        "请在系统中允许 MailAI“后台自启动”，并在应用省电设置选“无限制”。这里无法读取小米自启动开关，请以系统页面为准。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = { open("autostart") },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("设置后台自启动")
                    }
                    Text(
                        "如果未跳到对应页面，可在系统设置搜索“后台自启动”。应用信息 → 省电策略中设置“无限制”；名称因系统版本可能不同。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { open("battery") }) { Text("打开应用省电设置") }
                Text(
                    "系统强行停止、极限省电或禁止后台联网仍会阻止收信。允许后台运行不代表应用会持续占用网络。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                HorizontalDivider()
                Text("最近后台检查", fontWeight = FontWeight.Medium)
                // Reading revision also invalidates records when a worker finishes off-screen.
                key(revision) {
                    accounts.forEach { account ->
                        val record = health.check(account.id)
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(account.email, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                when {
                                    record.started == 0L -> "尚无后台检查记录；前台刷新与此分开记录"
                                    record.interrupted ->
                                        "${backgroundStamp(record.started)} · ${if (running) "正在检查" else "上次检查未完成，将在下次继续"}"
                                    record.failure.isNotBlank() ->
                                        "${backgroundStamp(record.finished)} · ${BackgroundHealth.explanation(record.failure)}"
                                    else -> "${backgroundStamp(record.finished)} · 后台收信检查成功"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (pending) {
                    Text(
                        if (running) "正在检查收信…" else "等待网络或系统允许后台检查…",
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    TextButton(
                        onClick = {
                            WorkManager.getInstance(context).cancelUniqueWork("mail-catch-up")
                        }
                    ) {
                        Text("取消本次检查")
                    }
                } else {
                    Button(
                        onClick = { BackgroundSchedule.catchUp(context, force = true) },
                        enabled = prefs.background && accounts.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("立即检查收信")
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("通知显示发件人与主题")
                        Text(
                            "关闭时仅提醒有新邮件",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        prefs.previews,
                        onCheckedChange = { value ->
                            prefs.previews = value
                            if (!value)
                                accounts.forEach {
                                    androidx.core.app.NotificationManagerCompat.from(context)
                                        .cancel("mail.${it.id}", 1)
                                }
                        },
                    )
                }
                Text(
                    "当前是手机独立定期收信，并非即时推送；锁屏及时性需要在这台手机上验证。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun backgroundStamp(time: Long) =
    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(time))
