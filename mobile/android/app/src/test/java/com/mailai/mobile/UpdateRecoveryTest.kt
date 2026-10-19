package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.update.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
class UpdateRecoveryTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun updates(): Pair<AppUpdates, UpdateCandidate> {
        val c =
            UpdateCandidate(
                "2.10.0-beta.3",
                BuildConfig.VERSION_CODE + 1L,
                "${RELEASE_PREFIX}android-v2.10.0-beta.3/a.apk",
                "a".repeat(64),
                3,
                "合成更新",
                "https://github.com/langjiahui/MailAI/releases/tag/android-v2.10.0-beta.3",
            )
        context
            .getSharedPreferences("mailai.updates", Context.MODE_PRIVATE)
            .edit()
            .putString("candidate", c.json().toString())
            .commit()
        return AppUpdates(context) to c
    }

    @Test
    fun independentAndroidVersionUsesInstallSequenceAndIgnoresWebAndBetaReleases() = runBlocking {
        com.mailai.mobile.background.AppPreferences(context).autoDownload = false
        val manifestName = "mailai-android-update.json"
        fun release(
            version: String,
            code: Long,
            prerelease: Boolean = false,
        ): Pair<JSONObject, JSONObject> {
            val tag = "android-v$version"
            val candidate =
                UpdateCandidate(
                    version,
                    code,
                    "$RELEASE_PREFIX$tag/MailAI-Android-$version.apk",
                    "a".repeat(64),
                    1234,
                    "合成更新",
                    "https://github.com/langjiahui/MailAI/releases/tag/$tag",
                )
            val assets =
                JSONArray()
                    .put(
                        JSONObject()
                            .put("name", "MailAI-Android-$version.apk")
                            .put("browser_download_url", candidate.url)
                            .put("size", candidate.size)
                    )
                    .put(
                        JSONObject()
                            .put("name", manifestName)
                            .put("browser_download_url", "$RELEASE_PREFIX$tag/$manifestName")
                    )
            return JSONObject()
                .put("tag_name", tag)
                .put("prerelease", prerelease)
                .put("assets", assets) to
                candidate.json().put("schema", 1).put("applicationId", BuildConfig.APPLICATION_ID)
        }
        val legacy = release("2.10.0", BuildConfig.VERSION_CODE - 1L)
        val current = release("1.0.0", BuildConfig.VERSION_CODE.toLong())
        val next = release("1.0.1", BuildConfig.VERSION_CODE + 1L)
        val beta = release("1.1.0-beta.1", BuildConfig.VERSION_CODE + 2L, true)
        val web = JSONObject().put("tag_name", "v99.0.0")
        val releases =
            JSONArray()
                .put(web)
                .put(legacy.first)
                .put(beta.first)
                .put(next.first)
                .put(current.first)
        var requestedBeta = false
        val http =
            UpdateHttp(
                OkHttpClient.Builder()
                    .addInterceptor {
                        val url = it.request().url.toString()
                        val body =
                            if (url == RELEASES) releases.toString()
                            else {
                                if (url.contains("beta")) requestedBeta = true
                                when {
                                    url.contains("android-v2.10.0/") -> legacy.second.toString()
                                    url.contains("android-v1.0.0/") -> current.second.toString()
                                    url.contains("android-v1.0.1/") -> next.second.toString()
                                    else -> error("Unexpected update resource: $url")
                                }
                            }
                        Response.Builder()
                            .request(it.request())
                            .protocol(Protocol.HTTP_1_1)
                            .code(200)
                            .message("OK")
                            .body(body.toResponseBody())
                            .build()
                    }
                    .build()
            )
        val updates = AppUpdates(context)
        assertTrue(updates.check(http))
        assertEquals("1.0.1", updates.state.value.candidate!!.version)
        assertEquals(BuildConfig.VERSION_CODE + 1L, updates.state.value.candidate!!.code)
        assertFalse(requestedBeta)
        releases.remove(3)
        assertTrue(updates.check(http))
        assertNull(updates.state.value.candidate)
        assertEquals("已是最新版本", updates.state.value.message)
    }

    @Test
    fun cancelledSocketIsNotReportedAsDownloadFailure() = runBlocking {
        val (updates, c) = updates()
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val http =
            UpdateHttp(
                OkHttpClient.Builder()
                    .addInterceptor {
                        entered.countDown()
                        check(finish.await(5, TimeUnit.SECONDS))
                        throw IOException("socket closed")
                    }
                    .build()
            )
        val job =
            launch(Dispatchers.IO) {
                try {
                    updates.fetch(c.code, http)
                    fail("must propagate cancellation")
                } catch (_: CancellationException) {}
            }
        withContext(Dispatchers.IO) { assertTrue(entered.await(5, TimeUnit.SECONDS)) }
        updates.download() // A second request must not replace active progress with "preparing".
        assertEquals("正在下载更新…", updates.state.value.message)
        http.cancel()
        finish.countDown()
        job.join()
        assertFalse(updates.state.value.failed)
        assertFalse(updates.state.value.downloading)
        assertTrue(updates.state.value.message.contains("已取消"))
        assertFalse(updates.apk(c).exists())
    }

    @Test
    fun cancellingCheckClearsBusyStateWithoutFailure() = runBlocking {
        val (updates, _) = updates()
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val http =
            UpdateHttp(
                OkHttpClient.Builder()
                    .addInterceptor {
                        entered.countDown()
                        check(finish.await(5, TimeUnit.SECONDS))
                        throw IOException("socket closed")
                    }
                    .build()
            )
        val job =
            launch(Dispatchers.IO) {
                try {
                    updates.check(http)
                    fail("must propagate cancellation")
                } catch (_: CancellationException) {}
            }
        withContext(Dispatchers.IO) { assertTrue(entered.await(5, TimeUnit.SECONDS)) }
        http.cancel()
        finish.countDown()
        job.join()
        assertFalse(updates.state.value.failed)
        assertFalse(updates.state.value.checking)
    }

    @Test
    fun genuineNetworkFailureRemainsRetryable() = runBlocking {
        val (updates, c) = updates()
        val http =
            UpdateHttp(
                OkHttpClient.Builder().addInterceptor { throw IOException("offline") }.build()
            )
        assertFalse(updates.fetch(c.code, http))
        assertTrue(updates.state.value.failed)
        assertFalse(updates.state.value.ready)
        assertFalse(updates.state.value.downloading)
    }

    @Test
    fun damagedDownloadNeverBecomesAnInstallableApk() = runBlocking {
        val (updates, c) = updates()
        val http =
            UpdateHttp(
                OkHttpClient.Builder()
                    .addInterceptor {
                        Response.Builder()
                            .request(it.request())
                            .protocol(Protocol.HTTP_1_1)
                            .code(200)
                            .message("OK")
                            .body("bad".toResponseBody())
                            .build()
                    }
                    .build()
            )
        assertFalse(updates.fetch(c.code, http))
        assertTrue(updates.state.value.failed)
        assertFalse(updates.state.value.ready)
        assertFalse(updates.apk(c).exists())
        assertFalse(java.io.File(context.filesDir, "updates/mailai-${c.code}.part").exists())
    }
}
