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
