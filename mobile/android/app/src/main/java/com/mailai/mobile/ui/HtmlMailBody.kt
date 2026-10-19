package com.mailai.mobile.ui

import android.graphics.Bitmap
import android.net.Uri
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import java.io.ByteArrayInputStream
import java.io.File
import java.net.Proxy
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.*

/** Only rewritten image resources can leave the renderer; no cookies, scripts or file access. */
internal class MailImageLoader(private val directory: File, private val scopeKey: String) {
    private val calls = ConcurrentHashMap.newKeySet<Call>()
    @Volatile private var closed = false

    fun close() {
        closed = true
        calls.forEach { it.cancel() }
        calls.clear()
    }

    fun image(url: String): Pair<String, ByteArray>? =
        runCatching {
                check(!closed && MailHtml.httpsImage(url))
                val key =
                    MessageDigest.getInstance("SHA-256")
                        .digest((scopeKey + url).toByteArray())
                        .joinToString("") { "%02x".format(it) }
                directory.mkdirs()
                val file = File(directory, key)
                if (file.isFile && file.length() <= MAX_IMAGE) {
                    val bytes = file.readBytes()
                    val type =
                        runCatching { File(directory, "$key.mime").readText() }
                            .getOrNull()
                            ?.takeIf { it.startsWith("image/") } ?: "image/png"
                    return@runCatching type to bytes
                }
                var current = url
                repeat(5) {
                    check(!closed && MailHtml.httpsImage(current))
                    val call = client.newCall(Request.Builder().url(current).get().build())
                    calls.add(call)
                    try {
                        call.execute().use { response ->
                            if (response.code in setOf(301, 302, 303, 307, 308)) {
                                current =
                                    response.request.url
                                        .resolve(
                                            response.header("Location") ?: error("No location")
                                        )
                                        ?.toString() ?: error("Invalid location")
                            } else {
                                check(response.isSuccessful)
                                val type =
                                    response
                                        .header("Content-Type")
                                        .orEmpty()
                                        .substringBefore(';')
                                        .lowercase()
                                check(
                                    type in
                                        setOf(
                                            "image/png",
                                            "image/jpeg",
                                            "image/gif",
                                            "image/webp",
                                            "image/bmp",
                                            "image/avif",
                                        )
                                )
                                val body = requireNotNull(response.body)
                                check(body.contentLength() <= MAX_IMAGE)
                                val bytes =
                                    body.byteStream().use { input ->
                                        val output = java.io.ByteArrayOutputStream()
                                        val buffer = ByteArray(8192)
                                        while (true) {
                                            check(!closed)
                                            val n = input.read(buffer)
                                            if (n < 0) break
                                            check(output.size() + n <= MAX_IMAGE)
                                            output.write(buffer, 0, n)
                                        }
                                        output.toByteArray()
                                    }
                                check(!closed)
                                val pending = File.createTempFile("image-", ".part", directory)
                                try {
                                    File(directory, "$key.mime").writeText(type)
                                    pending.writeBytes(bytes)
                                    pending.renameTo(file)
                                } finally {
                                    pending.delete()
                                }
                                directory
                                    .listFiles()
                                    .orEmpty()
                                    .filter { it.isFile && it.name.length == 64 }
                                    .sortedBy { it.lastModified() }
                                    .let { files ->
                                        var size = files.sumOf { it.length() }
                                        files.forEach { cached ->
                                            if (size > 64L * 1024 * 1024) {
                                                size -= cached.length()
                                                cached.delete()
                                            }
                                        }
                                    }
                                return@runCatching type to bytes
                            }
                        }
                    } finally {
                        calls.remove(call)
                    }
                }
                null
            }
            .getOrNull()

    companion object {
        const val MAX_IMAGE = 5 * 1024 * 1024
        private val client =
            OkHttpClient.Builder()
                .proxy(Proxy.NO_PROXY)
                .dns(
                    object : Dns {
                        override fun lookup(hostname: String) =
                            listOf(NetworkPolicy.resolve(hostname))
                    }
                )
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .callTimeout(15, TimeUnit.SECONDS)
                .build()
    }
}

@Composable
internal fun HtmlMailBody(
    vm: MailViewModel,
    mail: MailItem,
    modifier: Modifier = Modifier,
    onLink: (String) -> Unit,
) {
    val context = LocalContext.current
    val account = vm.account ?: return
    val document = remember(mail.html) { MailHtml.prepare(mail.html.orEmpty()) }
    val loader =
        remember(mail.key, account.id) {
            MailImageLoader(File(context.cacheDir, "mail-images"), account.id + mail.key)
        }
    DisposableEffect(loader) { onDispose { loader.close() } }
    var failed by remember(mail.key) { mutableStateOf(false) }
    var loading by remember(mail.key) { mutableStateOf(true) }
    var scroll by rememberSaveable(mail.key) { mutableIntStateOf(0) }
    var revision by remember(mail.key) { mutableIntStateOf(0) }
    val fontScale = LocalDensity.current.fontScale
    Column(modifier) {
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
        else Spacer(Modifier.height(2.dp))
        if (failed) {
            Column(
                Modifier.weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(18.dp)
            ) {
                Text("原版暂时无法显示，已保留文本正文", fontSize = 13.sp)
                TextButton(
                    onClick = {
                        failed = false
                        revision++
                    }
                ) {
                    Text("重新显示原邮件")
                }
                Text(mail.body.orEmpty(), fontSize = 16.sp)
            }
        } else
            key(mail.key, mail.html, mail.attachments.map { it.local }, revision) {
                AndroidView(
                    modifier =
                        Modifier.fillMaxWidth().weight(1f).clipToBounds().testTag("html-body"),
                    factory = {
                        val initialScroll = scroll
                        WebView(it).apply {
                            settings.javaScriptEnabled = false
                            settings.domStorageEnabled = false
                            settings.allowFileAccess = false
                            settings.allowContentAccess = false
                            settings.javaScriptCanOpenWindowsAutomatically = false
                            settings.setSupportMultipleWindows(false)
                            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            settings.setSupportZoom(true)
                            settings.builtInZoomControls = true
                            settings.displayZoomControls = false
                            settings.textZoom = (fontScale * 100).toInt()
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                            setOnScrollChangeListener { _, _, y, _, _ -> scroll = y }
                            webViewClient =
                                object : WebViewClient() {
                                    override fun onPageStarted(
                                        view: WebView?,
                                        url: String?,
                                        favicon: Bitmap?,
                                    ) {
                                        loading = true
                                    }

                                    override fun onPageFinished(view: WebView, url: String?) {
                                        loading = false
                                        view.post { view.scrollTo(0, initialScroll) }
                                    }

                                    override fun onReceivedError(
                                        view: WebView?,
                                        request: WebResourceRequest,
                                        error: WebResourceError?,
                                    ) {
                                        if (request.isForMainFrame) {
                                            loading = false
                                            failed = true
                                        }
                                    }

                                    override fun onReceivedHttpError(
                                        view: WebView?,
                                        request: WebResourceRequest,
                                        errorResponse: WebResourceResponse?,
                                    ) {
                                        if (request.isForMainFrame) {
                                            loading = false
                                            failed = true
                                        }
                                    }

                                    override fun onRenderProcessGone(
                                        view: WebView?,
                                        detail: RenderProcessGoneDetail?,
                                    ): Boolean {
                                        failed = true
                                        loading = false
                                        return true
                                    }

                                    override fun shouldOverrideUrlLoading(
                                        view: WebView?,
                                        request: WebResourceRequest,
                                    ): Boolean {
                                        if (
                                            request.isForMainFrame &&
                                                request.hasGesture() &&
                                                MailHtml.linkAllowed(request.url.toString())
                                        )
                                            onLink(request.url.toString())
                                        return true
                                    }

                                    override fun shouldInterceptRequest(
                                        view: WebView?,
                                        request: WebResourceRequest,
                                    ): WebResourceResponse? {
                                        if (request.isForMainFrame && request.url.scheme == "data")
                                            return null
                                        if (
                                            request.isForMainFrame &&
                                                request.url.toString() ==
                                                    MailHtml.ORIGIN + "document"
                                        ) {
                                            return WebResourceResponse(
                                                "text/html",
                                                "utf-8",
                                                ByteArrayInputStream(
                                                    document.html.toByteArray(Charsets.UTF_8)
                                                ),
                                            )
                                        }
                                        val source = document.images[request.url.toString()]
                                        val result =
                                            if (source?.startsWith("cid:", true) == true) {
                                                val cid =
                                                    Uri.decode(source.substring(4))
                                                        .removeSurrounding("<", ">")
                                                mail.attachments
                                                    .find {
                                                        it.contentId == cid &&
                                                            it.local.isNotBlank() &&
                                                            it.type.startsWith("image/")
                                                    }
                                                    ?.let { file ->
                                                        runCatching {
                                                                file.type to
                                                                    vm.repo
                                                                        .file(account, file.local)
                                                                        .readBytes()
                                                            }
                                                            .getOrNull()
                                                    }
                                            } else if (source != null) loader.image(source)
                                            else null
                                        return if (result != null)
                                            WebResourceResponse(
                                                result.first,
                                                null,
                                                ByteArrayInputStream(result.second),
                                            )
                                        else
                                            WebResourceResponse(
                                                "text/plain",
                                                "utf-8",
                                                404,
                                                "Not available",
                                                emptyMap(),
                                                ByteArrayInputStream(byteArrayOf()),
                                            )
                                    }
                                }
                            loadDataWithBaseURL(
                                MailHtml.ORIGIN + "document",
                                document.html,
                                "text/html",
                                "utf-8",
                                null,
                            )
                        }
                    },
                    onRelease = {
                        it.stopLoading()
                        it.webViewClient = WebViewClient()
                        it.destroy()
                    },
                    update = { it.settings.textZoom = (fontScale * 100).toInt() },
                )
            }
    }
}
