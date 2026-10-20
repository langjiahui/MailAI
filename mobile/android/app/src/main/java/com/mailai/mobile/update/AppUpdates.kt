package com.mailai.mobile.update

import android.content.Context
import android.content.pm.PackageManager
import androidx.work.*
import com.mailai.mobile.BuildConfig
import com.mailai.mobile.MailApplication
import com.mailai.mobile.background.AppPreferences
import com.mailai.mobile.background.MailNotifications
import com.mailai.mobile.background.cancellableIo
import com.mailai.mobile.mail.NetworkPolicy
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject

internal const val RELEASES = "https://api.github.com/repos/langjiahui/MailAI/releases?per_page=30"
internal const val RELEASE_PREFIX = "https://github.com/langjiahui/MailAI/releases/download/"
internal const val MAX_APK = 150L * 1024 * 1024

data class UpdateCandidate(
    val version: String,
    val code: Long,
    val url: String,
    val sha256: String,
    val size: Long,
    val notes: String,
    val page: String,
    val mirrorUrl: String = "",
) {
    fun json(): JSONObject =
        JSONObject()
            .put("version", version)
            .put("code", code)
            .put("url", url)
            .put("sha256", sha256)
            .put("size", size)
            .put("notes", notes)
            .put("page", page)
            .put("mirrorUrl", mirrorUrl)

    companion object {
        fun from(j: JSONObject) =
            UpdateCandidate(
                j.getString("version"),
                j.getLong("code"),
                j.getString("url"),
                j.getString("sha256"),
                j.getLong("size"),
                j.getString("notes"),
                j.getString("page"),
                j.optString("mirrorUrl"),
            )
    }
}

data class UpdateState(
    val candidate: UpdateCandidate? = null,
    val checking: Boolean = false,
    val downloading: Boolean = false,
    val progress: Float = 0f,
    val ready: Boolean = false,
    val message: String = "",
    val failed: Boolean = false,
    val checkedAt: Long = 0,
    val queued: Boolean = false,
    val waitingForWifi: Boolean = false,
    val verifying: Boolean = false,
    val automatic: Boolean = false,
    val failureStage: UpdateFailureStage? = null,
)

enum class UpdateFailureStage {
    CHECK,
    DOWNLOAD,
    VERIFY,
}

internal class UpdateHttpException(val status: Int) : IOException("HTTP $status")

internal class UpdateValidationException(val explanation: String) : IOException(explanation)

internal fun updateFailureMessage(error: Exception, stage: UpdateFailureStage): String =
    when {
        error is UpdateValidationException -> error.explanation
        error is SocketTimeoutException -> "连接超时，请换个网络后重试"
        error is UnknownHostException -> "无法连接更新服务，请检查网络后重试"
        error is SSLException -> "无法建立安全连接，请换个网络后重试"
        error is UpdateHttpException && error.status in listOf(403, 429) -> "更新服务暂时限制访问，请稍后重试"
        error is UpdateHttpException -> "更新服务暂时不可用，请稍后重试"
        error.message.orEmpty().contains("ENOSPC") ||
            error.message.orEmpty().contains("No space left") -> "手机空间不足，请释放空间后重试"
        stage == UpdateFailureStage.VERIFY -> "安装包未通过验证，已阻止安装，请重新下载"
        stage == UpdateFailureStage.CHECK && error !is IOException -> "更新信息暂时无法确认，请稍后重试"
        else -> "网络连接中断，请检查网络后重试"
    }

/** URL allowlist is applied on every redirect; DNS answers are validated and used by OkHttp. */
internal object UpdatePolicy {
    fun requireUrl(value: String) {
        val u = URI(value)
        require(
            u.scheme == "https" &&
                u.rawUserInfo == null &&
                (u.port == -1 || u.port == 443) &&
                u.fragment == null
        )
        require(
            u.host in
                setOf(
                    "api.github.com",
                    "github.com",
                    "release-assets.githubusercontent.com",
                    "objects.githubusercontent.com",
                    "raw.atomgit.com",
                    "atomgit.com",
                    "file.gitcode.com",
                )
        ) {
            "更新地址不受信任"
        }
        when (u.host) {
            "api.github.com" -> require(u.path.startsWith("/repos/langjiahui/MailAI/releases"))
            "github.com" -> require(value.startsWith(RELEASE_PREFIX))
            "raw.atomgit.com" -> require(value == DOMESTIC_MANIFEST)
            "atomgit.com" ->
                require(
                    value.startsWith("${DOMESTIC_RELEASES}download/android-v") && u.rawQuery == null
                )
        }
    }

    fun manifest(j: JSONObject, tag: String, assets: JSONArray): UpdateCandidate {
        require(
            j.getInt("schema") == 1 && j.getString("applicationId") == BuildConfig.APPLICATION_ID
        ) {
            "更新包不适用于当前应用"
        }
        val candidate = UpdateCandidate.from(j)
        require(
            tag == "android-v${candidate.version}" &&
                tag.matches(Regex("android-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-beta\\.[0-9]+)?"))
        )
        require(
            candidate.code > 0 &&
                candidate.size in 1..MAX_APK &&
                candidate.sha256.matches(Regex("[a-f0-9]{64}"))
        )
        require(candidate.notes.length <= 10000 && candidate.version.length <= 80)
        require(candidate.page == "https://github.com/langjiahui/MailAI/releases/tag/$tag")
        require(candidate.url.startsWith("$RELEASE_PREFIX$tag/") && candidate.url.endsWith(".apk"))
        requireUrl(candidate.url)
        require(
            (0 until assets.length()).any { i ->
                assets.getJSONObject(i).let {
                    it.optString("browser_download_url") == candidate.url &&
                        it.optLong("size") == candidate.size
                }
            }
        ) {
            "安装包与发布清单不一致"
        }
        return candidate
    }
}

internal class UpdateHttp(clientOverride: OkHttpClient? = null) {
    @Volatile private var stopped = false
    @Volatile private var call: Call? = null
    val isCancelled: Boolean
        get() = stopped || Thread.currentThread().isInterrupted

    private val client =
        clientOverride
            ?: OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(25, TimeUnit.SECONDS)
                .callTimeout(5, TimeUnit.MINUTES)
                .dns(
                    object : Dns {
                        override fun lookup(hostname: String) =
                            listOf(NetworkPolicy.resolve(hostname))
                    }
                )
                .build()

    fun cancel() {
        stopped = true
        call?.cancel()
    }

    fun check() {
        if (isCancelled) throw CancellationException("更新已取消")
    }

    fun response(url: String): Response {
        var current = url
        repeat(6) {
            check()
            UpdatePolicy.requireUrl(current)
            val next =
                client.newCall(
                    Request.Builder()
                        .url(current)
                        .header("User-Agent", "MailAI-Android/${BuildConfig.VERSION_NAME}")
                        .build()
                )
            call = next
            check()
            val response = next.execute()
            if (response.code in listOf(301, 302, 303, 307, 308)) {
                val location = response.header("Location")
                response.close()
                require(!location.isNullOrBlank())
                current = URI(current).resolve(location).toString()
            } else {
                if (!response.isSuccessful) {
                    val code = response.code
                    response.close()
                    throw UpdateHttpException(code)
                }
                return response
            }
        }
        throw IOException("更新跳转次数过多")
    }

    fun json(url: String): String =
        response(url).use { r ->
            val body = requireNotNull(r.body)
            require(body.contentLength() <= 1024 * 1024)
            val out = java.io.ByteArrayOutputStream()
            body.byteStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    check()
                    val n = input.read(buffer)
                    if (n < 0) break
                    require(out.size() + n <= 1024 * 1024)
                    out.write(buffer, 0, n)
                }
            }
            out.toString("UTF-8")
        }
}

class AppUpdates(private val context: Context) {
    private val prefs = context.getSharedPreferences("mailai.updates", Context.MODE_PRIVATE)
    private val checkMutex = Mutex()
    private val requestLock = Any()
    @Volatile private var checkHttp: UpdateHttp? = null
    @Volatile private var downloadHttp: UpdateHttp? = null
    private val directory = File(context.filesDir, "updates").apply { mkdirs() }

    private fun cached(): UpdateCandidate? =
        runCatching { UpdateCandidate.from(JSONObject(prefs.getString("candidate", "")!!)) }
            .getOrNull()
            ?.takeIf { it.code > BuildConfig.VERSION_CODE }

    private val initial = cached()
    private val mutable =
        MutableStateFlow(
            UpdateState(
                candidate = initial,
                ready = initial?.let { apk(it).isFile } == true,
                checkedAt = prefs.getLong("checkedAt", 0),
                queued = initial != null && prefs.contains("downloadRequest"),
                waitingForWifi =
                    initial != null &&
                        prefs.contains("downloadRequest") &&
                        prefs.getBoolean("wifiOnly", false),
                automatic = prefs.getBoolean("wifiOnly", false),
            )
        )
    val state = mutable.asStateFlow()

    init {
        if (initial == null) prefs.edit().remove("downloadRequest").commit()
    }

    private fun current(key: String, id: String) =
        synchronized(requestLock) { prefs.getString(key, null) == id }

    private fun begin(key: String): String =
        synchronized(requestLock) {
            UUID.randomUUID().toString().also { prefs.edit().putString(key, it).commit() }
        }

    private fun finish(key: String, id: String) =
        synchronized(requestLock) {
            if (prefs.getString(key, null) == id) prefs.edit().remove(key).commit()
        }

    private fun publish(key: String, id: String, change: (UpdateState) -> UpdateState) =
        synchronized(requestLock) { if (prefs.getString(key, null) == id) mutable.update(change) }

    private fun ensureCurrent(key: String, id: String, http: UpdateHttp) {
        http.check()
        if (!current(key, id)) throw CancellationException("更新操作已取消")
    }

    fun apk(c: UpdateCandidate) = File(directory, "mailai-${c.code}.apk")

    fun checkNow() {
        if (state.value.checking || state.value.downloading || state.value.queued) return
        val id = begin("checkRequest")
        mutable.update {
            it.copy(message = "正在检查更新…", failed = false, failureStage = null, checking = true)
        }
        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                "update-check-now",
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<UpdateCheckWorker>()
                    .setInputData(workDataOf("request" to id))
                    .build(),
            )
    }

    fun cancelCheck() {
        synchronized(requestLock) { prefs.edit().remove("checkRequest").commit() }
        checkHttp?.cancel()
        WorkManager.getInstance(context).cancelUniqueWork("update-check-now")
        mutable.update {
            it.copy(checking = false, failed = false, failureStage = null, message = "检查已取消")
        }
    }

    fun download(automatic: Boolean = false, replaceQueued: Boolean = false) {
        val c = state.value.candidate?.takeIf { it.code > BuildConfig.VERSION_CODE } ?: return
        if (
            state.value.checking ||
                state.value.downloading ||
                (state.value.queued && !replaceQueued) ||
                (automatic && state.value.ready)
        )
            return
        val id = begin("downloadRequest")
        prefs.edit().putBoolean("wifiOnly", automatic).commit()
        mutable.update {
            it.copy(
                queued = true,
                waitingForWifi = automatic,
                automatic = automatic,
                ready = false,
                message = if (automatic) "连接 Wi-Fi 后自动下载" else "等待网络，连接后开始下载",
                failed = false,
                failureStage = null,
                verifying = false,
                progress = 0f,
            )
        }
        val manager = WorkManager.getInstance(context)
        manager.cancelUniqueWork("update-auto-download") // Retire the previous duplicate queue.
        manager.enqueueUniqueWork(
            "update-download",
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<UpdateDownloadWorker>()
                .setInputData(workDataOf("code" to c.code, "request" to id))
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(
                            if (automatic) NetworkType.UNMETERED else NetworkType.CONNECTED
                        )
                        .build()
                )
                .build(),
        )
    }

    fun cancelDownload() {
        synchronized(requestLock) { prefs.edit().remove("downloadRequest").commit() }
        downloadHttp?.cancel()
        val manager = WorkManager.getInstance(context)
        manager.cancelUniqueWork("update-download")
        manager.cancelUniqueWork("update-auto-download")
        mutable.update {
            it.copy(
                downloading = false,
                queued = false,
                waitingForWifi = false,
                verifying = false,
                failed = false,
                failureStage = null,
                message = "下载已取消，可稍后重试",
            )
        }
    }

    internal suspend fun check(
        http: UpdateHttp,
        requestId: String? = null,
        channelVerifier: (String) -> UpdateCandidate = DomesticUpdates::discover,
    ): Boolean =
        checkMutex.withLock {
            if (
                requestId == null &&
                    (state.value.checking || state.value.downloading || state.value.queued)
            )
                return@withLock true
            val id = requestId ?: begin("checkRequest")
            if (!current("checkRequest", id)) return@withLock true
            checkHttp = http
            publish("checkRequest", id) {
                it.copy(checking = true, message = "正在检查更新…", failed = false, failureStage = null)
            }
            try {
                var domestic: UpdateCandidate? = null
                val releases =
                    try {
                        JSONArray(http.json(RELEASES))
                    } catch (e: Exception) {
                        ensureCurrent("checkRequest", id, http)
                        domestic = channelVerifier(http.json(DOMESTIC_MANIFEST))
                        JSONArray()
                    }
                val eligible =
                    (0 until releases.length())
                        .map { releases.getJSONObject(it) }
                        .filter {
                            !it.optBoolean("draft") &&
                                it.optString("tag_name").startsWith("android-v") &&
                                (BuildConfig.VERSION_NAME.contains("-beta.") ||
                                    !it.optBoolean("prerelease"))
                        }
                // Product policy requires monotonically increasing install codes on publication.
                // Real GitHub feeds provide publication dates: consult the newest manifest once,
                // rather than letting an old/deleted historical asset block a fresh update.
                val dated =
                    eligible.isNotEmpty() &&
                        eligible.all {
                            it.optString("published_at")
                                .matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z"))
                        }
                val ordered =
                    if (dated) eligible.sortedByDescending { it.optString("published_at") }
                    else eligible
                var best: UpdateCandidate? = domestic?.takeIf { it.code > BuildConfig.VERSION_CODE }
                try {
                    for (release in ordered) {
                        ensureCurrent("checkRequest", id, http)
                        val tag = release.getString("tag_name")
                        val assets = release.getJSONArray("assets")
                        val manifest =
                            (0 until assets.length())
                                .map { assets.getJSONObject(it) }
                                .find { it.optString("name") == "mailai-android-update.json" }
                                ?: continue
                        val url = manifest.getString("browser_download_url")
                        require(url == "$RELEASE_PREFIX$tag/mailai-android-update.json")
                        val original =
                            UpdatePolicy.manifest(JSONObject(http.json(url)), tag, assets)
                        val c =
                            original.copy(
                                mirrorUrl =
                                    runCatching { DomesticUpdates.mirror(original) }
                                        .getOrDefault("")
                            )
                        if (
                            c.code > BuildConfig.VERSION_CODE &&
                                (best == null || c.code > best.code)
                        )
                            best = c
                        if (dated) break
                    }
                } catch (e: Exception) {
                    ensureCurrent("checkRequest", id, http)
                    domestic = channelVerifier(http.json(DOMESTIC_MANIFEST))
                    best = domestic?.takeIf { it.code > BuildConfig.VERSION_CODE }
                }
                ensureCurrent("checkRequest", id, http)
                val now = System.currentTimeMillis()
                val previous = state.value
                synchronized(requestLock) {
                    ensureCurrent("checkRequest", id, http)
                    prefs
                        .edit()
                        .putLong("checkedAt", now)
                        .putString("candidate", best?.json()?.toString())
                        .putBoolean("preferDomestic", domestic != null)
                        .commit()
                    mutable.update {
                        it.copy(
                            candidate = best,
                            checking = false,
                            checkedAt = now,
                            ready = best?.let { c -> apk(c).isFile } == true,
                            message = if (best == null) "已是最新版本" else "发现新版本 ${best!!.version}",
                            failed = false,
                            failureStage = null,
                        )
                    }
                }
                if (best != null && best.code != previous.candidate?.code)
                    MailNotifications.update(context, false)
                if (best != null && AppPreferences(context).autoDownload) download(true)
                true
            } catch (e: Exception) {
                if (
                    e is CancellationException || http.isCancelled || !current("checkRequest", id)
                ) {
                    publish("checkRequest", id) {
                        it.copy(checking = false, failed = false, message = "检查已取消")
                    }
                    throw CancellationException("检查已取消")
                }
                publish("checkRequest", id) {
                    it.copy(
                        checking = false,
                        message = updateFailureMessage(e, UpdateFailureStage.CHECK),
                        failed = true,
                        failureStage = UpdateFailureStage.CHECK,
                    )
                }
                false
            } finally {
                finish("checkRequest", id)
                if (checkHttp === http) checkHttp = null
            }
        }

    internal suspend fun fetch(code: Long, http: UpdateHttp, requestId: String? = null): Boolean =
        checkMutex.withLock {
            http.check()
            val c = state.value.candidate?.takeIf { it.code == code } ?: return@withLock true
            val id = requestId ?: begin("downloadRequest")
            if (!current("downloadRequest", id)) return@withLock true
            val pending = File(directory, "mailai-$code.part")
            var stage = UpdateFailureStage.DOWNLOAD
            var resumeQueuedWork = false
            downloadHttp = http
            publish("downloadRequest", id) {
                it.copy(
                    downloading = true,
                    queued = false,
                    waitingForWifi = false,
                    verifying = false,
                    progress = 0f,
                    failed = false,
                    failureStage = null,
                    message = "正在下载更新…",
                )
            }
            try {
                val validCached = apk(c).isFile && runCatching { verify(c) }.isSuccess
                if (!validCached) {
                    apk(c).delete()
                    require(c.mirrorUrl.isBlank() || c.mirrorUrl == DomesticUpdates.mirror(c))
                    val urls =
                        (if (domesticCandidate(c)) listOf(c.mirrorUrl, c.url)
                            else listOf(c.url, c.mirrorUrl))
                            .filter { it.isNotBlank() }
                            .distinct()
                    var received = false
                    for ((index, downloadUrl) in urls.withIndex()) {
                        try {
                            http.response(downloadUrl).use { response ->
                                val body = requireNotNull(response.body)
                                if (body.contentLength() != -1L && body.contentLength() != c.size)
                                    throw UpdateValidationException("下载文件大小不符，请重新下载")
                                body.byteStream().use { input ->
                                    pending.outputStream().use { output ->
                                        val buffer = ByteArray(32768)
                                        var count = 0L
                                        var last = 0L
                                        while (true) {
                                            ensureCurrent("downloadRequest", id, http)
                                            val n = input.read(buffer)
                                            if (n < 0) break
                                            count += n
                                            if (count > c.size || count > MAX_APK)
                                                throw UpdateValidationException("下载文件大小不符，请重新下载")
                                            output.write(buffer, 0, n)
                                            val now = System.nanoTime()
                                            if (now - last > 150_000_000) {
                                                last = now
                                                publish("downloadRequest", id) {
                                                    it.copy(progress = count.toFloat() / c.size)
                                                }
                                            }
                                        }
                                        if (count != c.size)
                                            throw UpdateValidationException("下载未完成，请重新下载")
                                        output.fd.sync()
                                    }
                                }
                            }
                            received = true
                            break
                        } catch (e: Exception) {
                            ensureCurrent("downloadRequest", id, http)
                            if (index == urls.lastIndex || e is UpdateValidationException) throw e
                            pending.delete()
                        }
                    }
                    check(received)
                    ensureCurrent("downloadRequest", id, http)
                    stage = UpdateFailureStage.VERIFY
                    publish("downloadRequest", id) {
                        it.copy(message = "正在验证安装包…", progress = 1f, verifying = true)
                    }
                    verifyFile(pending, c)
                    ensureCurrent("downloadRequest", id, http)
                    check(pending.renameTo(apk(c)))
                }
                ensureCurrent("downloadRequest", id, http)
                publish("downloadRequest", id) {
                    it.copy(
                        downloading = false,
                        queued = false,
                        verifying = false,
                        ready = true,
                        progress = 1f,
                        message = "更新已准备好，点击安装",
                        failed = false,
                        failureStage = null,
                    )
                }
                MailNotifications.update(context, true)
                directory
                    .listFiles()
                    ?.filter { it.name.endsWith(".apk") && it != apk(c) }
                    ?.forEach { it.delete() }
                true
            } catch (e: Exception) {
                if (
                    e is CancellationException ||
                        http.isCancelled ||
                        !current("downloadRequest", id)
                ) {
                    // A constraint stop (for example Wi-Fi loss) is rescheduled by WorkManager.
                    // Retain that request token; only an explicit user cancellation removes it.
                    resumeQueuedWork = requestId != null && current("downloadRequest", id)
                    publish("downloadRequest", id) {
                        it.copy(
                            downloading = false,
                            queued = resumeQueuedWork,
                            waitingForWifi = resumeQueuedWork && it.automatic,
                            verifying = false,
                            failed = false,
                            message = if (resumeQueuedWork) "网络恢复后将重新下载" else "下载已取消，可稍后重试",
                        )
                    }
                    throw CancellationException("下载已暂停或取消")
                }
                publish("downloadRequest", id) {
                    it.copy(
                        downloading = false,
                        queued = false,
                        verifying = false,
                        ready = false,
                        message = updateFailureMessage(e, stage),
                        failed = true,
                        failureStage = stage,
                    )
                }
                apk(c).delete()
                false
            } finally {
                pending.delete()
                if (!resumeQueuedWork) finish("downloadRequest", id)
                if (downloadHttp === http) downloadHttp = null
            }
        }

    suspend fun verifiedApk(): File =
        withContext(Dispatchers.IO) {
            val c = requireNotNull(state.value.candidate) { "请先检查更新" }
            try {
                verify(c)
                apk(c)
            } catch (e: Exception) {
                apk(c).delete()
                mutable.update {
                    it.copy(
                        ready = false,
                        failed = true,
                        failureStage = UpdateFailureStage.VERIFY,
                        message = updateFailureMessage(e, UpdateFailureStage.VERIFY),
                    )
                }
                throw e
            }
        }

    private fun verify(c: UpdateCandidate) = verifyFile(apk(c), c)

    private fun domesticCandidate(c: UpdateCandidate): Boolean =
        c.mirrorUrl.isNotBlank() && prefs.getBoolean("preferDomestic", false)

    private fun verifyFile(file: File, c: UpdateCandidate) {
        if (file.length() != c.size) throw UpdateValidationException("安装包不完整，请重新下载")
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32768)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        if (digest.digest().joinToString("") { "%02x".format(it) } != c.sha256)
            throw UpdateValidationException("安装包校验失败，已阻止安装，请重新下载")
        @Suppress("DEPRECATION")
        val archive =
            requireNotNull(
                context.packageManager.getPackageArchiveInfo(
                    file.path,
                    PackageManager.GET_SIGNING_CERTIFICATES,
                )
            )
        @Suppress("DEPRECATION")
        val current =
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.GET_SIGNING_CERTIFICATES,
            )
        require(
            archive.packageName == context.packageName &&
                archive.longVersionCode == c.code &&
                c.code > current.longVersionCode &&
                archive.versionName == c.version
        ) {
            "安装包版本不匹配"
        }
        val a =
            requireNotNull(archive.signingInfo)
                .apkContentsSigners
                .map { it.toCharsString() }
                .toSet()
        val b =
            requireNotNull(current.signingInfo)
                .apkContentsSigners
                .map { it.toCharsString() }
                .toSet()
        require(a.isNotEmpty() && a == b) { "安装包签名不匹配" }
    }
}

class UpdateCheckWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
    private val http = UpdateHttp()

    override suspend fun doWork(): Result =
        cancellableIo(http::cancel) {
            if (
                (applicationContext as MailApplication)
                    .updates
                    .check(http, inputData.getString("request"))
            )
                Result.success()
            else Result.failure()
        }
}

class UpdateDownloadWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
    private val http = UpdateHttp()

    override suspend fun doWork(): Result =
        cancellableIo(http::cancel) {
            if (
                (applicationContext as MailApplication)
                    .updates
                    .fetch(inputData.getLong("code", -1), http, inputData.getString("request"))
            )
                Result.success()
            else Result.failure()
        }
}
