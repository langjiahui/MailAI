package com.mailai.mobile

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.assistant.*
import com.mailai.mobile.data.SecretCipher
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class AssistantControllerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val config =
        AssistantConfig(
            "https://model.example.test/v1/chat/completions",
            "fixture-model",
            "fixture-key",
        )
    private val source = AssistantContext("a", "a@example.test", "mail-a", "主题", "邮件内容")
    private val cipher =
        object : SecretCipher {
            override fun encrypt(text: String) = text.reversed()

            override fun decrypt(text: String) = text.reversed()
        }

    private fun waitFor(test: () -> Boolean) {
        val until = System.nanoTime() + 8_000_000_000
        while (!test() && System.nanoTime() < until) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(test())
    }

    private fun rig(
        transport: AssistantTransport
    ): Triple<AssistantController, CoroutineScope, AssistantCache> {
        val settings = AssistantSettings(context, cipher)
        settings.save(config)
        val cache = AssistantCache(context)
        cache.clear()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        return Triple(AssistantController(context, scope, settings, cache, transport), scope, cache)
    }

    @Test
    fun idleAndRepeatedOpeningNeverCallTheModelAndCompletedResultsAreReused() {
        val calls = AtomicInteger()
        val (a, scope, _) =
            rig { _, _, op, progress ->
                calls.incrementAndGet()
                op.check()
                progress("摘要")
                "摘要"
            }
        try {
            repeat(5) {
                a.open(source)
                waitFor { !a.loading }
                a.close()
            }
            assertEquals(0, calls.get())
            a.open(source)
            a.start(AssistantTask.SUMMARY)
            a.start(AssistantTask.SUMMARY)
            waitFor { !a.generating }
            assertTrue(a.complete)
            assertEquals(1, calls.get())
            a.close()
            a.open(source)
            a.start(AssistantTask.SUMMARY)
            waitFor { !a.generating }
            assertEquals("摘要", a.text)
            assertEquals(1, calls.get())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun backgroundCancellationPreservesPartialTextAndNeverAutomaticallyResumes() {
        val calls = AtomicInteger()
        val (a, scope, cache) =
            rig { _, _, op, progress ->
                calls.incrementAndGet()
                progress("已经接收的一部分")
                while (true) {
                    op.check()
                    Thread.sleep(5)
                }
                @Suppress("UNREACHABLE_CODE") ""
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            a.start(AssistantTask.SUMMARY)
            waitFor { a.text.isNotBlank() }
            a.background()
            assertTrue(a.stopping)
            waitFor { !a.generating }
            assertFalse(a.stopping)
            assertFalse(a.complete)
            assertEquals("已经接收的一部分", a.text)
            val persisted = cache.get(source.cacheKey(config, AssistantTask.SUMMARY, ""))
            assertNotNull(persisted)
            assertFalse(persisted!!.complete)
            a.open(source)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(1, calls.get())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun changingMailDoesNotLetCancelledProgressPolluteTheNextMail() {
        val calls = AtomicInteger()
        val (a, scope, cache) =
            rig { _, _, op, progress ->
                calls.incrementAndGet()
                progress("旧邮件的部分内容")
                while (true) {
                    op.check()
                    Thread.sleep(5)
                }
                @Suppress("UNREACHABLE_CODE") ""
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            a.start(AssistantTask.SUMMARY)
            waitFor { a.text.isNotBlank() }
            val other =
                source.copy(
                    accountId = "b",
                    accountLabel = "b@example.test",
                    sourceId = "mail-b",
                    text = "另一封邮件",
                )
            a.open(other)
            waitFor { cache.get(source.cacheKey(config, AssistantTask.SUMMARY, "")) != null }
            assertEquals(other, a.source)
            assertEquals("", a.text)
            assertNull(a.task)
            assertFalse(a.complete)
            assertNull(cache.get(other.cacheKey(config, AssistantTask.SUMMARY, "")))
            assertEquals(1, calls.get())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun changingEndpointCannotReuseTheOldKeyWithoutExplicitNewInput() {
        val (a, scope, _) = rig { _, _, _, _ -> "unused" }
        try {
            a.open(source)
            waitFor { !a.loading }
            a.saveSettings(
                "https://other.example.test/v1/chat/completions",
                config.model,
                "",
                false,
                true,
            )
            assertTrue(a.failed)
            assertEquals(config.endpoint, a.endpoint)
            a.saveSettings(config.endpoint, config.model, "", false, false)
            assertTrue(a.failed)
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun nextRequestWaitsForCancelledConnectionCleanupInsteadOfOverlapping() {
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val calls = AtomicInteger()
        val (a, scope, _) =
            rig { _, _, op, progress ->
                val n = active.incrementAndGet()
                peak.updateAndGet { maxOf(it, n) }
                try {
                    if (calls.incrementAndGet() == 1) {
                        progress("旧任务")
                        try {
                            while (true) {
                                op.check()
                                Thread.sleep(5)
                            }
                        } finally {
                            Thread.sleep(100)
                        }
                    }
                    progress("新任务结果")
                    "新任务结果"
                } finally {
                    active.decrementAndGet()
                }
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            a.start(AssistantTask.SUMMARY)
            waitFor { a.text.isNotBlank() }
            a.open(source.copy(sourceId = "next", text = "新邮件"))
            a.start(AssistantTask.SUMMARY)
            waitFor { a.complete && !a.generating }
            assertEquals("新任务结果", a.text)
            assertEquals(1, peak.get())
            assertEquals(2, calls.get())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }
}
