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
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
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

    @Test
    fun connectionProbeUsesNoMailDoesNotSaveAndRejectsDuplicateActions() {
        val calls = AtomicInteger()
        val (a, scope, cache) =
            rig { _, messages, _, _ ->
                calls.incrementAndGet()
                assertEquals(1, messages.length())
                assertEquals("请只回复 OK。", messages.getJSONObject(0).getString("content"))
                assertFalse(messages.toString().contains(source.text))
                Thread.sleep(40)
                "OK"
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            val endpoint = AssistantProviders.get("deepseek").endpoint
            a.testSettings(endpoint, "deepseek-flash", "synthetic-new-key", false, true, "deepseek")
            a.testSettings(endpoint, "deepseek-flash", "synthetic-new-key", false, true, "deepseek")
            a.start(AssistantTask.SUMMARY)
            waitFor { !a.testing }
            assertEquals(1, calls.get())
            assertTrue(a.verificationMessage.contains("连接成功"))
            assertEquals(config, AssistantSettings(context, cipher).read())
            assertEquals("", a.text)
            assertNull(cache.get(source.cacheKey(config, AssistantTask.SUMMARY, "")))
            a.saveSettings("https://model.example.test/v1/", config.model, "", false, true)
            waitFor { !a.loading }
            assertFalse(a.failed)
            assertEquals(config, AssistantSettings(context, cipher).read())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun corporateHttpCanBeTestedSavedAndEditedWithoutMovingTheOldKey() {
        val calls = AtomicInteger()
        val (a, scope, _) =
            rig { c, _, _, _ ->
                calls.incrementAndGet()
                assertEquals("http://10.42.0.8/v1/chat/completions", c.endpoint)
                assertEquals("Kimi-K2.6", c.model)
                assertTrue(c.privateNetwork)
                assertEquals("synthetic-corporate-key", c.key)
                "OK"
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            val endpoint = "http://10.42.0.8:80/v1"
            a.testSettings(endpoint, "Kimi-K2.6", "synthetic-corporate-key", false, true, "custom")
            assertTrue(a.verificationFailed)
            assertEquals(0, calls.get())
            a.testSettings(endpoint, "Kimi-K2.6", "synthetic-corporate-key", true, true, "custom")
            waitFor { !a.testing }
            assertFalse(a.verificationFailed)
            assertEquals(1, calls.get())
            assertEquals(config, AssistantSettings(context, cipher).read())
            a.saveSettings(endpoint, "Kimi-K2.6", "synthetic-corporate-key", true, true, "custom")
            waitFor { !a.loading }
            assertFalse(a.failed)
            a.saveSettings(
                "http://10.42.0.8/v1/chat/completions",
                "Qwen2.5-72B",
                "",
                true,
                true,
                "custom",
            )
            waitFor { !a.loading }
            assertFalse(a.failed)
            val saved = AssistantSettings(context, cipher).read()!!
            assertEquals("Qwen2.5-72B", saved.model)
            assertEquals("synthetic-corporate-key", saved.key)
            a.saveSettings("http://10.42.0.9/v1", "Qwen2.5-72B", "", true, true, "custom")
            assertTrue(a.failed)
            assertEquals(saved, AssistantSettings(context, cipher).read())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }

    @Test
    fun failedOrCancelledProbePreservesTheSavedConfigurationAndNeverRestarts() {
        val calls = AtomicInteger()
        val (a, scope, _) =
            rig { _, _, op, _ ->
                if (calls.incrementAndGet() == 1)
                    throw AssistantFailure("Kimi Code 未开放当前客户端（HTTP 403）")
                while (true) {
                    op.check()
                    Thread.sleep(5)
                }
                @Suppress("UNREACHABLE_CODE") ""
            }
        try {
            a.open(source)
            waitFor { !a.loading }
            a.testSettings(config.endpoint, config.model, "", false, true)
            waitFor { !a.testing }
            assertTrue(a.verificationFailed)
            assertTrue(a.verificationMessage.contains("HTTP 403"))
            a.testSettings(config.endpoint, config.model, "", false, true)
            waitFor { calls.get() == 2 }
            a.background()
            waitFor { !a.testing }
            assertFalse(a.verificationFailed)
            assertTrue(a.verificationMessage.contains("已取消"))
            assertEquals(config, AssistantSettings(context, cipher).read())
            a.open(source)
            waitFor { !a.loading }
            assertEquals(2, calls.get())
            a.testSettings("https://other.example.test/v1", config.model, "", false, true)
            assertTrue(a.verificationFailed)
            assertEquals(2, calls.get())
        } finally {
            a.dispose()
            scope.cancel()
        }
    }
}
