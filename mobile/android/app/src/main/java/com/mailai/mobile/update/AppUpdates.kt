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
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
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
)

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
                )
        ) {
            "更新地址不受信任"
        }
        when (u.host) {
            "api.github.com" -> require(u.path.startsWith("/repos/langjiahui/MailAI/releases"))
            "github.com" -> require(value.startsWith(RELEASE_PREFIX))
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
                tag.matches(Regex("android-v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+"))
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
                    throw IOException("HTTP $code")
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
            )
        )
    val state = mutable.asStateFlow()

    fun apk(c: UpdateCandidate) = File(directory, "mailai-${c.code}.apk")

    fun checkNow() {
        if (state.value.checking || state.value.downloading) return
        mutable.value = mutable.value.copy(message = "正在检查更新…", failed = false, checking = true)
        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                "update-check-now",
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<UpdateCheckWorker>().build(),
            )
    }

    fun download(automatic: Boolean = false) {
        val c = state.value.candidate ?: return
        if (state.value.downloading || (automatic && state.value.ready)) return
        val work =
            OneTimeWorkRequestBuilder<UpdateDownloadWorker>()
                .setInputData(workDataOf("code" to c.code))
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(
                            if (automatic) NetworkType.UNMETERED else NetworkType.CONNECTED
                        )
                        .build()
                )
                .build()
        mutable.update { current ->
            if (current.downloading) current
            else
                current.copy(
                    message = if (automatic) "等待 Wi-Fi 下载更新" else "正在准备下载…",
                    failed = false,
                )
        }
        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                if (automatic) "update-auto-download" else "update-download",
                ExistingWorkPolicy.KEEP,
                work,
            )
    }

    fun cancelDownload() {
        val manager = WorkManager.getInstance(context)
        manager.cancelUniqueWork("update-download")
        manager.cancelUniqueWork("update-auto-download")
        mutable.value =
            mutable.value.copy(downloading = false, message = "下载已取消，可稍后重试", failed = false)
    }

    internal suspend fun check(http: UpdateHttp): Boolean =
        checkMutex.withLock {
            mutable.value = state.value.copy(checking = true, message = "正在检查更新…", failed = false)
            try {
                val releases = JSONArray(http.json(RELEASES))
                var best: UpdateCandidate? = null
                for (i in 0 until releases.length()) {
                    val release = releases.getJSONObject(i)
                    val tag = release.optString("tag_name")
                    if (release.optBoolean("draft") || !tag.startsWith("android-v")) continue
                    val assets = release.getJSONArray("assets")
                    val manifest =
                        (0 until assets.length())
                            .map { assets.getJSONObject(it) }
                            .find { it.optString("name") == "mailai-android-update.json" }
                            ?: continue
                    val url = manifest.getString("browser_download_url")
                    require(url == "$RELEASE_PREFIX$tag/mailai-android-update.json")
                    val c = UpdatePolicy.manifest(JSONObject(http.json(url)), tag, assets)
                    if (c.code > BuildConfig.VERSION_CODE && (best == null || c.code > best.code))
                        best = c
                }
                http.check()
                val now = System.currentTimeMillis()
                prefs
                    .edit()
                    .putLong("checkedAt", now)
                    .putString("candidate", best?.json()?.toString())
                    .commit()
                val previous = state.value
                mutable.value =
                    previous.copy(
                        candidate = best,
                        checking = false,
                        checkedAt = now,
                        ready = best?.let { apk(it).isFile } == true,
                        message = if (best == null) "已是当前测试通道的最新版本" else "发现新版本 ${best.version}",
                        failed = false,
                    )
                if (best != null && best.code != previous.candidate?.code)
                    MailNotifications.update(context, false)
                if (best != null && AppPreferences(context).autoDownload) download(true)
                true
            } catch (e: CancellationException) {
                mutable.value = state.value.copy(checking = false)
                throw e
            } catch (_: Exception) {
                if (http.isCancelled) {
                    mutable.value =
                        state.value.copy(checking = false, message = "检查已取消", failed = false)
                    throw CancellationException("检查已取消")
                }
                mutable.value =
                    state.value.copy(checking = false, message = "暂时无法检查更新，请检查网络后重试", failed = true)
                false
            }
        }

    internal suspend fun fetch(code: Long, http: UpdateHttp): Boolean =
        checkMutex.withLock {
            http.check()
            val c = state.value.candidate?.takeIf { it.code == code } ?: return@withLock true
            val pending = File(directory, "mailai-$code.part")
            mutable.value =
                state.value.copy(
                    downloading = true,
                    progress = 0f,
                    failed = false,
                    message = "正在下载更新…",
                )
            try {
                val validCached = apk(c).isFile && runCatching { verify(c) }.isSuccess
                if (!validCached) {
                    apk(c).delete()
                    http.response(c.url).use { response ->
                        val body = requireNotNull(response.body)
                        require(body.contentLength() == -1L || body.contentLength() == c.size) {
                            "安装包大小不匹配"
                        }
                        body.byteStream().use { input ->
                            pending.outputStream().use { output ->
                                val buffer = ByteArray(32768)
                                var count = 0L
                                var last = 0L
                                while (true) {
                                    http.check()
                                    val n = input.read(buffer)
                                    if (n < 0) break
                                    count += n
                                    require(count <= c.size && count <= MAX_APK)
                                    output.write(buffer, 0, n)
                                    val now = System.nanoTime()
                                    if (now - last > 150_000_000) {
                                        last = now
                                        mutable.value =
                                            state.value.copy(progress = count.toFloat() / c.size)
                                    }
                                }
                                require(count == c.size) { "安装包下载不完整" }
                                output.fd.sync()
                            }
                        }
                    }
                    http.check()
                    mutable.value = state.value.copy(message = "正在验证安装包…", progress = 1f)
                    verifyFile(pending, c)
                    http.check()
                    check(pending.renameTo(apk(c)))
                }
                mutable.value =
                    state.value.copy(
                        downloading = false,
                        ready = true,
                        progress = 1f,
                        message = "更新已准备好，点击安装",
                    )
                MailNotifications.update(context, true)
                directory
                    .listFiles()
                    ?.filter { it.name.endsWith(".apk") && it != apk(c) }
                    ?.forEach { it.delete() }
                true
            } catch (e: CancellationException) {
                mutable.value = state.value.copy(downloading = false, message = "下载已取消")
                throw e
            } catch (_: Exception) {
                // Call.cancel() closes a blocked socket with IOException, not
                // CancellationException.
                if (http.isCancelled) {
                    mutable.value =
                        state.value.copy(
                            downloading = false,
                            message = "下载已取消，可稍后重试",
                            failed = false,
                        )
                    throw CancellationException("下载已取消")
                }
                mutable.value =
                    state.value.copy(
                        downloading = false,
                        ready = false,
                        message = "下载或验证失败，请重试",
                        failed = true,
                    )
                apk(c).delete()
                false
            } finally {
                pending.delete()
            }
        }

    suspend fun verifiedApk(): File =
        withContext(Dispatchers.IO) {
            val c = requireNotNull(state.value.candidate) { "请先检查更新" }
            verify(c)
            apk(c)
        }

    private fun verify(c: UpdateCandidate) = verifyFile(apk(c), c)

    private fun verifyFile(file: File, c: UpdateCandidate) {
        require(file.length() == c.size)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32768)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        require(digest.digest().joinToString("") { "%02x".format(it) } == c.sha256) { "安装包校验失败" }
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
            if ((applicationContext as MailApplication).updates.check(http)) Result.success()
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
                    .fetch(inputData.getLong("code", -1), http)
            )
                Result.success()
            else Result.failure()
        }
}
