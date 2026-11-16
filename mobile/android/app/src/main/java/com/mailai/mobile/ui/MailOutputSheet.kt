package com.mailai.mobile.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.mailai.mobile.data.Account
import com.mailai.mobile.data.MailItem
import com.mailai.mobile.mail.MailOutput
import com.mailai.mobile.mail.createMailPdf
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun outputView(context: Context) =
    WebView(context).apply {
        settings.javaScriptEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.blockNetworkLoads = true
        settings.domStorageEnabled = false
        setBackgroundColor(android.graphics.Color.WHITE)
        webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: android.webkit.WebResourceRequest,
                ) = true
            }
    }

/** Hand the current email to the Android print service. */
internal fun printMailDocument(
    context: Context,
    document: MailOutput.Document,
    failed: (String) -> Unit,
) {
    val view = outputView(context)
    val handler = Handler(Looper.getMainLooper())
    var started = false
    val timeout = Runnable {
        if (!started) {
            started = true
            view.destroy()
            failed("邮件排版加载超时，请重试")
        }
    }
    handler.postDelayed(timeout, 20000)
    view.webViewClient =
        object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: android.webkit.WebResourceRequest,
            ) = true

            override fun onPageFinished(webView: WebView, url: String) {
                if (started) return
                started = true
                handler.removeCallbacks(timeout)
                val delegate = view.createPrintDocumentAdapter(document.name)
                val adapter =
                    object : PrintDocumentAdapter() {
                        override fun onStart() = delegate.onStart()

                        override fun onLayout(
                            old: PrintAttributes?,
                            new: PrintAttributes,
                            signal: CancellationSignal,
                            callback: LayoutResultCallback,
                            extras: Bundle?,
                        ) = delegate.onLayout(old, new, signal, callback, extras)

                        override fun onWrite(
                            pages: Array<out PageRange>,
                            destination: ParcelFileDescriptor,
                            signal: CancellationSignal,
                            callback: WriteResultCallback,
                        ) = delegate.onWrite(pages, destination, signal, callback)

                        override fun onFinish() {
                            delegate.onFinish()
                            view.destroy()
                        }
                    }
                try {
                    val manager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                    manager.print(
                        document.name,
                        adapter,
                        PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .build(),
                    )
                } catch (_: Exception) {
                    view.destroy()
                    failed("无法打开系统打印服务，请稍后重试")
                }
            }
        }
    view.loadDataWithBaseURL(
        "https://mailai.invalid/output",
        document.html,
        "text/html",
        "UTF-8",
        null,
    )
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun MailOutputSheet(
    vm: MailViewModel,
    account: Account,
    mail: MailItem,
    mode: String,
    close: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val printing = mode == "print"
    var document by remember(account.id, mail.key) { mutableStateOf<MailOutput.Document?>(null) }
    var error by remember { mutableStateOf("") }
    var selectedFormat by remember { mutableStateOf("pdf") }
    var pdf by remember(account.id, mail.key) { mutableStateOf<File?>(null) }
    var raw by remember { mutableStateOf<File?>(null) }
    var working by remember { mutableStateOf(false) }
    var alive by remember { mutableStateOf(true) }
    DisposableEffect(Unit) { onDispose { alive = false } }
    val preview = remember { outputView(context) }
    val surface = MaterialTheme.colorScheme.surfaceContainerLow.toArgb()
    val ink = MaterialTheme.colorScheme.onSurface.toArgb().toUInt().toString(16).takeLast(6)
    val muted =
        MaterialTheme.colorScheme.onSurfaceVariant.toArgb().toUInt().toString(16).takeLast(6)
    val accent = MaterialTheme.colorScheme.primary.toArgb().toUInt().toString(16).takeLast(6)
    val previewStyle =
        """
        <style>@media screen {
            html { background:#${surface.toUInt().toString(16).takeLast(6)}; color:#$ink; }
            header, blockquote { border-color:#$muted; }
            .note { color:#$muted; }
            main [style] { background-color:transparent!important; color:inherit!important; }
            a, main a[style] { color:#$accent!important; }
        }</style>
    """
            .trimIndent()
    DisposableEffect(preview) { onDispose { preview.destroy() } }
    LaunchedEffect(account.id, mail.key) {
        try {
            document =
                withContext(Dispatchers.IO) {
                    var total = 0L
                    MailOutput.document(mail) { cid ->
                        val attachment =
                            mail.attachments.firstOrNull {
                                it.contentId.trim('<', '>').equals(cid, true)
                            }
                        val file =
                            attachment
                                ?.takeIf { it.local.isNotBlank() }
                                ?.let { vm.repo.file(account, it.local) }
                        if (
                            file != null &&
                                file.isFile &&
                                file.length() <= 3L * 1024 * 1024 &&
                                total + file.length() <= 8L * 1024 * 1024 &&
                                attachment.type.lowercase() in
                                    setOf(
                                        "image/png",
                                        "image/jpeg",
                                        "image/gif",
                                        "image/webp",
                                        "image/bmp",
                                    )
                        ) {
                            total += file.length()
                            "data:${attachment.type};base64," +
                                android.util.Base64.encodeToString(
                                    file.readBytes(),
                                    android.util.Base64.NO_WRAP,
                                )
                        } else null
                    }
                }
        } catch (failure: Exception) {
            error = failure.message ?: "无法准备邮件输出"
        }
    }
    fun shareFile(file: File, type: String, name: String) {
        try {
            val uri =
                FileProvider.getUriForFile(context, "${context.packageName}.files", file, name)
            val intent =
                Intent(Intent.ACTION_SEND).apply {
                    this.type = type
                    putExtra(Intent.EXTRA_STREAM, uri)
                    clipData = ClipData.newUri(context.contentResolver, name, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            context.startActivity(Intent.createChooser(intent, "分享邮件"))
        } catch (_: android.content.ActivityNotFoundException) {
            error = "没有可接收此文件的应用，请保存到本地"
        }
    }
    val saveRaw =
        rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument("message/rfc822")
        ) { uri ->
            if (uri != null && raw != null)
                scope.launch {
                    working = true
                    try {
                        withContext(Dispatchers.IO) {
                            context.contentResolver.openOutputStream(uri)?.use { output ->
                                raw!!.inputStream().use { it.copyTo(output) }
                            } ?: error("无法打开保存位置")
                        }
                        error = "已保存原始邮件"
                    } catch (_: Exception) {
                        error = "原始邮件保存失败，请重试"
                    } finally {
                        working = false
                    }
                }
        }
    val savePdf =
        rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument("application/pdf")
        ) { uri ->
            val file = pdf
            if (uri != null && file != null)
                scope.launch {
                    working = true
                    try {
                        withContext(Dispatchers.IO) {
                            context.contentResolver.openOutputStream(uri)?.use { output ->
                                file.inputStream().use { it.copyTo(output) }
                            } ?: error("无法打开保存位置")
                        }
                        error = "PDF 已保存"
                    } catch (_: java.io.IOException) {
                        error = "PDF 保存失败，请重试"
                    } catch (_: IllegalStateException) {
                        error = "PDF 保存失败，请重试"
                    } finally {
                        working = false
                    }
                }
        }
    fun preparePdf(output: MailOutput.Document, ready: (File) -> Unit) {
        scope.launch {
            working = true
            error = "正在生成 PDF…"
            try {
                val file =
                    pdf?.takeIf { it.isFile }
                        ?: withContext(Dispatchers.IO) { createMailPdf(context, output) }
                            .also { pdf = it }
                error = ""
                ready(file)
            } catch (failure: kotlinx.coroutines.CancellationException) {
                throw failure
            } catch (_: Exception) {
                error = "PDF 生成失败，请重试"
            } finally {
                working = false
            }
        }
    }
    fun prepareRaw(ready: (File) -> Unit) {
        vm.originalForOutput(account, mail, failed = { if (alive) error = it }) { file ->
            if (alive) {
                raw = file
                ready(file)
            }
        }
    }
    MailBottomSheet(
        title = if (printing) "打印邮件" else "分享邮件",
        closeLabel = "关闭",
        onDismiss = close,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).testTag("mail-output-sheet"),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(mail.subject.ifBlank { "（无主题）" }, style = MaterialTheme.typography.titleMedium)
                if (!printing)
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf("pdf" to "PDF", "text" to "文本", "eml" to "原始邮件").forEach {
                            (value, label) ->
                            FilterChip(
                                selected = selectedFormat == value,
                                border = null,
                                onClick = {
                                    selectedFormat = value
                                    error = ""
                                },
                                label = { Text(label) },
                            )
                        }
                    }
                if (!printing)
                    Text(
                        when (selectedFormat) {
                            "pdf" -> "从当前邮件生成 PDF，附件仅列出名称及大小。"
                            "eml" -> "EML 包含完整邮件头、正文和全部附件。首次导出需要联网读取原始邮件，之后可离线使用。"
                            else -> "复制或分享主题、邮件头及完整正文，附件仅列出名称。"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                document?.let { output ->
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    ) {
                        if (selectedFormat == "text") {
                            SelectionContainer(Modifier.padding(16.dp)) {
                                Text(output.text, style = MaterialTheme.typography.bodyMedium)
                            }
                        } else {
                            AndroidView(
                                factory = { preview },
                                update = { view ->
                                    val previewKey = output to previewStyle
                                    if (view.tag != previewKey) {
                                        view.tag = previewKey
                                        view.setBackgroundColor(surface)
                                        view.loadDataWithBaseURL(
                                            "https://mailai.invalid/output",
                                            output.html.replaceFirst(
                                                "</head>",
                                                "$previewStyle</head>",
                                            ),
                                            "text/html",
                                            "UTF-8",
                                            null,
                                        )
                                    }
                                },
                                modifier =
                                    Modifier.fillMaxWidth()
                                        .height(240.dp)
                                        .clipToBounds()
                                        .testTag("mail-output-preview"),
                            )
                        }
                    }
                }
                if (error.isNotBlank()) Text(error, style = MaterialTheme.typography.bodySmall)
                if (selectedFormat == "eml" && vm.busy)
                    Text(vm.status, style = MaterialTheme.typography.bodySmall)
            }
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            ) {
                when (selectedFormat) {
                    "pdf" -> {
                        if (printing) {
                            Button(
                                onClick = {
                                    document?.let { printMailDocument(context, it) { error = it } }
                                },
                                enabled = document != null && !working,
                            ) {
                                Text("打印")
                            }
                        } else {
                            Button(
                                onClick = {
                                    document?.let { output ->
                                        preparePdf(output) {
                                            shareFile(it, "application/pdf", output.name + ".pdf")
                                        }
                                    }
                                },
                                enabled = document != null && !working,
                            ) {
                                Text("分享 PDF")
                            }
                            OutlinedButton(
                                onClick = {
                                    document?.let { output ->
                                        preparePdf(output) { savePdf.launch(output.name + ".pdf") }
                                    }
                                },
                                enabled = document != null && !working,
                            ) {
                                Text("另存为 PDF")
                            }
                        }
                    }
                    "text" -> {
                        Button(
                            onClick = {
                                val clipboard =
                                    context.getSystemService(Context.CLIPBOARD_SERVICE)
                                        as android.content.ClipboardManager
                                clipboard.setPrimaryClip(
                                    ClipData.newPlainText("邮件", document!!.text)
                                )
                                error = "已复制邮件文本"
                            },
                            enabled = document != null,
                        ) {
                            Text("复制文本")
                        }
                        OutlinedButton(
                            onClick = {
                                try {
                                    context.startActivity(
                                        Intent.createChooser(
                                            Intent(Intent.ACTION_SEND).apply {
                                                type = "text/plain"
                                                putExtra(Intent.EXTRA_TEXT, document!!.text)
                                            },
                                            "分享邮件",
                                        )
                                    )
                                } catch (_: android.content.ActivityNotFoundException) {
                                    error = "没有可接收文本的应用，请复制文本"
                                }
                            },
                            enabled = document != null,
                        ) {
                            Text("系统分享")
                        }
                    }
                    "eml" -> {
                        Button(
                            onClick = {
                                prepareRaw {
                                    shareFile(
                                        it,
                                        "message/rfc822",
                                        MailOutput.fileName(mail.subject) + ".eml",
                                    )
                                }
                            },
                            enabled = !vm.busy && !working,
                        ) {
                            Text("分享 EML")
                        }
                        OutlinedButton(
                            onClick = {
                                prepareRaw {
                                    saveRaw.launch(MailOutput.fileName(mail.subject) + ".eml")
                                }
                            },
                            enabled = !vm.busy && !working,
                        ) {
                            Text("保存 EML")
                        }
                    }
                }
            }
        }
    }
}
