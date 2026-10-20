package com.mailai.mobile.ui

import android.content.ClipData
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mailai.mobile.BuildConfig
import com.mailai.mobile.background.AppPreferences
import com.mailai.mobile.background.BackgroundSchedule
import com.mailai.mobile.update.AppUpdates
import com.mailai.mobile.update.UpdateFailureStage
import com.mailai.mobile.update.UpdateState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Keep release engineering metadata out of the short, readable product summary. */
internal fun updateHighlights(notes: String): List<String> {
    val metadata = listOf("基准版本", "变更类型", "目标版本", "判断依据", "versionCode", "标签")
    var hiddenSection = false
    return notes
        .lineSequence()
        .mapNotNull { raw ->
            val line = raw.trim()
            if (line.startsWith("#")) {
                hiddenSection = listOf("验证", "发布", "边界", "基准").any { line.contains(it) }
                null
            } else if (
                hiddenSection ||
                    !line.startsWith("- ") ||
                    metadata.any { line.removePrefix("- ").startsWith(it) }
            )
                null
            else
                line.removePrefix("- ").replace("**", "").replace("`", "").trim().takeIf {
                    it.isNotEmpty()
                }
        }
        .distinct()
        .toList()
}

internal fun updateHeading(state: UpdateState): String =
    when {
        state.checking -> "正在检查更新"
        state.verifying -> "正在验证安装包"
        state.downloading -> "正在下载更新"
        state.queued -> if (state.waitingForWifi) "等待 Wi-Fi" else "等待网络连接"
        state.failed ->
            when (state.failureStage) {
                UpdateFailureStage.CHECK -> "检查失败"
                UpdateFailureStage.VERIFY -> "安装包需要重新下载"
                else -> "下载未完成"
            }
        state.ready -> "更新已准备好"
        state.candidate != null -> "有可用更新"
        state.checkedAt > 0 && state.message == "已是最新版本" -> "已是最新版本"
        else -> "检查可用更新"
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppUpdateSheet(updates: AppUpdates, prefs: AppPreferences, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val state by updates.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var revision by remember { mutableIntStateOf(0) }
    var installing by remember { mutableStateOf(false) }
    var installMessage by remember { mutableStateOf("") }
    var mobileConfirmation by rememberSaveable { mutableStateOf(false) }
    DisposableEffect(prefs) {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> revision++ }
        prefs.data.registerOnSharedPreferenceChangeListener(listener)
        onDispose { prefs.data.unregisterOnSharedPreferenceChangeListener(listener) }
    }
    val autoCheck = remember(revision) { prefs.autoCheck }
    val autoDownload = remember(revision) { prefs.autoDownload }
    fun installVerified() {
        if (installing) return
        installing = true
        installMessage = "正在核对安装包…"
        scope.launch {
            try {
                val apk = updates.verifiedApk()
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
                context.startActivity(
                    Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .apply {
                            clipData = ClipData.newUri(context.contentResolver, "MailAI 更新", uri)
                        }
                )
                installMessage = "请在系统页面确认安装；取消后可再次安装"
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                installMessage = if (updates.state.value.failed) "" else "无法打开安装页面，请重试或从 GitHub 下载"
            } finally {
                installing = false
            }
        }
    }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (context.packageManager.canRequestPackageInstalls()) installVerified()
            else installMessage = "尚未允许安装更新，可再次点击安装并授权"
        }
    fun install() {
        if (context.packageManager.canRequestPackageInstalls()) installVerified()
        else {
            installMessage = "请允许安装更新，返回后将继续安装"
            try {
                permission.launch(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${context.packageName}"),
                    )
                )
            } catch (_: Exception) {
                installMessage = "无法打开安装权限设置，请在系统设置中允许 MailAI 安装应用"
            }
        }
    }
    fun download() {
        installMessage = ""
        val network = context.getSystemService(ConnectivityManager::class.java)
        if (network.activeNetwork != null && network.isActiveNetworkMetered)
            mobileConfirmation = true
        else updates.download(replaceQueued = true)
    }
    LaunchedEffect(Unit) {
        if (!state.ready && !state.checking && !state.downloading && !state.queued)
            updates.checkNow()
    }
    MailBottomSheet(title = "应用更新", onDismiss = onDismiss) {
        UpdatePanelContent(
            state,
            BuildConfig.VERSION_NAME,
            autoCheck,
            autoDownload,
            installing,
            installMessage,
            onCheck = {
                installMessage = ""
                updates.checkNow()
            },
            onDownload = ::download,
            onInstall = ::install,
            onCancel = { if (state.checking) updates.cancelCheck() else updates.cancelDownload() },
            onBrowser = {
                val url =
                    if (state.failureStage == UpdateFailureStage.CHECK || state.candidate == null)
                        "https://github.com/langjiahui/MailAI/releases"
                    else state.candidate!!.page
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) {
                    installMessage = "无法打开浏览器，请检查是否已安装浏览器"
                }
            },
            onAutoCheck = {
                prefs.autoCheck = it
                BackgroundSchedule.configure(context)
            },
            onAutoDownload = {
                prefs.autoDownload = it
                BackgroundSchedule.configure(context)
                if (it) updates.download(true)
                else if (state.queued && state.automatic) updates.cancelDownload()
            },
        )
    }
    if (mobileConfirmation)
        AlertDialog(
            onDismissRequest = { mobileConfirmation = false },
            title = { Text("使用当前网络下载？") },
            text = { Text("安装包约 ${fileSize(state.candidate?.size ?: 0)}，当前网络可能产生流量费用。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        mobileConfirmation = false
                        updates.download(replaceQueued = true)
                    }
                ) {
                    Text("下载")
                }
            },
            dismissButton = { TextButton(onClick = { mobileConfirmation = false }) { Text("取消") } },
        )
}

/** A scrollable reading area and a separate, always reachable action area. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ColumnScope.UpdatePanelContent(
    state: UpdateState,
    installedVersion: String,
    autoCheck: Boolean,
    autoDownload: Boolean,
    installing: Boolean = false,
    installMessage: String = "",
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
    onCancel: () -> Unit,
    onBrowser: () -> Unit,
    onAutoCheck: (Boolean) -> Unit,
    onAutoDownload: (Boolean) -> Unit,
) {
    var expandedNotes by rememberSaveable(state.candidate?.code) { mutableStateOf(false) }
    var expandedPreferences by rememberSaveable { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val candidate = state.candidate
    val busy = state.checking || state.downloading || state.queued || installing
    val checkFailure = state.failed && state.failureStage == UpdateFailureStage.CHECK
    Column(
        Modifier.weight(1f, fill = false)
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(2.dp))
        Text(
            updateHeading(state),
            fontSize = 24.sp,
            fontWeight = FontWeight.SemiBold,
            modifier =
                Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("update-heading"),
        )
        if (state.message.isNotBlank() && !state.checking && !state.downloading && !state.ready)
            Text(
                state.message,
                fontSize = 14.sp,
                color = if (state.failed) colors.error else colors.onSurfaceVariant,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        Text("当前版本 $installedVersion", fontSize = 13.sp, color = colors.onSurfaceVariant)
        if (candidate != null) {
            Surface(color = colors.surfaceContainer, shape = MaterialTheme.shapes.large) {
                Column(
                    Modifier.fillMaxWidth().padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        if (checkFailure) "上次发现 ${candidate.version}"
                        else if (candidate.version == installedVersion) "此版本有更新安装包"
                        else "MailAI ${candidate.version}",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        "${fileSize(candidate.size)} · 覆盖安装，保留邮箱和草稿",
                        fontSize = 12.sp,
                        color = colors.onSurfaceVariant,
                    )
                    if (candidate.version == installedVersion)
                        Text("可直接安装，无需逐级升级", fontSize = 12.sp, color = colors.onSurfaceVariant)
                }
            }
        }
        if (state.checking || state.verifying) LinearProgressIndicator(Modifier.fillMaxWidth())
        else if (state.downloading) {
            LinearProgressIndicator(
                progress = { state.progress.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "${(state.progress * 100).toInt().coerceIn(0, 100)}% · 可以关闭此页，下载会继续",
                fontSize = 12.sp,
                color = colors.onSurfaceVariant,
            )
        }
        if (installMessage.isNotBlank())
            Text(
                installMessage,
                fontSize = 13.sp,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        if (candidate != null) {
            val highlights = remember(candidate.notes) { updateHighlights(candidate.notes) }
            if (highlights.isNotEmpty()) {
                Text("本次更新", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                (if (expandedNotes) highlights else highlights.take(3)).forEach {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("·", color = colors.onSurfaceVariant)
                        Text(
                            it,
                            Modifier.weight(1f),
                            fontSize = 14.sp,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
                if (highlights.size > 3)
                    TextButton(onClick = { expandedNotes = !expandedNotes }) {
                        Text(if (expandedNotes) "收起更新内容" else "展开更新内容")
                    }
            }
        }
        if (state.checkedAt > 0)
            Text(
                "上次成功检查 ${SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(state.checkedAt))}",
                fontSize = 12.sp,
                color = colors.onSurfaceVariant,
            )
        HorizontalDivider(color = colors.outlineVariant)
        TextButton(
            onClick = { expandedPreferences = !expandedPreferences },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (expandedPreferences) "收起更新偏好" else "更新偏好", Modifier.weight(1f))
            Text(if (expandedPreferences) "−" else "+")
        }
        if (expandedPreferences) {
            UpdatePreference("自动检查更新", "每天检查一次正式版本", autoCheck, onAutoCheck)
            UpdatePreference("Wi-Fi 自动下载", "下载完成后，由你确认安装", autoDownload, onAutoDownload)
        }
        Spacer(Modifier.height(4.dp))
    }
    HorizontalDivider(color = colors.outlineVariant)
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 10.dp)
            .testTag("update-actions")
    ) {
        val label =
            when {
                installing -> "正在准备安装…"
                state.checking -> "正在检查更新…"
                state.verifying -> "正在验证安装包…"
                state.downloading -> "正在下载 ${(state.progress * 100).toInt().coerceIn(0, 100)}%"
                state.queued -> if (state.waitingForWifi) "连接 Wi-Fi 后下载" else "联网后继续下载"
                checkFailure -> "重试检查"
                state.ready -> "安装更新"
                candidate != null -> if (state.failed) "重新下载" else "下载更新"
                else -> "检查更新"
            }
        Button(
            onClick = {
                when {
                    checkFailure || candidate == null -> onCheck()
                    state.ready -> onInstall()
                    else -> onDownload()
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("update-primary"),
        ) {
            Text(label)
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            if (state.checking || state.downloading || state.queued)
                TextButton(onClick = onCancel) { Text(if (state.checking) "取消检查" else "取消下载") }
            if (state.queued && state.waitingForWifi)
                TextButton(onClick = onDownload) { Text("使用当前网络下载") }
            if (!busy && candidate != null && !checkFailure)
                TextButton(onClick = onCheck) { Text("重新检查") }
            if (!busy)
                TextButton(onClick = onBrowser) {
                    Text(if (state.failed) "从 GitHub 下载" else "完整发布说明")
                }
        }
    }
}

@Composable
private fun UpdatePreference(
    title: String,
    detail: String,
    checked: Boolean,
    change: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(checked, role = Role.Switch, onValueChange = change),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp)
            Text(detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, onCheckedChange = null)
    }
}
