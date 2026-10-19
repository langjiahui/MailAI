package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mailai.mobile.data.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun keystoreCipherSurvivesRecreationAndRejectsTampering() {
        val cipher = DeviceCipher()
        val value = cipher.encrypt("synthetic-test-secret")
        assertFalse(value.contains("synthetic-test-secret"))
        assertEquals("synthetic-test-secret", DeviceCipher().decrypt(value))
        val bytes = android.util.Base64.decode(value, android.util.Base64.NO_WRAP)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        try {
            cipher.decrypt(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
            fail("must reject modified ciphertext")
        } catch (_: java.security.GeneralSecurityException) {}
    }

    @Test
    fun importedAttachmentSurvivesRemovalOfOriginalFile() =
        kotlinx.coroutines.runBlocking {
            val source =
                File(context.cacheDir, "source-${java.util.UUID.randomUUID()}.txt").apply {
                    writeText("合成附件：原文件删除后仍可使用")
                }
            val a =
                Account(
                    email = "attachment@example.test",
                    imap = Server("imap.example.test"),
                    smtp = Server("smtp.example.test", 465),
                )
            val repo = MailRepository(context)
            val attachment =
                repo.import(a, android.net.Uri.fromFile(source), com.mailai.mobile.mail.Operation())
            assertTrue(source.delete())
            val d = Draft(body = "附件草稿", attachments = listOf(attachment))
            repo.store(a).save(d)
            MailStore(context, a.id).use { db ->
                val restored = db.draft(d.id)!!.attachments.single()
                assertEquals("合成附件：原文件删除后仍可使用", repo.file(a, restored.local).readText())
                assertEquals(attachment.size, repo.file(a, restored.local).length())
            }
        }

    @Test
    fun backgroundWorkerRecordsFailureWithoutLosingDraft() {
        val a =
            Account(
                id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
                email = "fixture@example.test",
                imap = Server("127.0.0.1", 993),
                smtp = Server("127.0.0.1", 465),
            )
        AccountStore(context).put(a, "synthetic-test-secret")
        val draft = Draft(body = "后台断网不能丢失的草稿")
        MailStore(context, a.id).use { it.save(draft) }
        val prefs = com.mailai.mobile.background.AppPreferences(context)
        prefs.background = true
        prefs.data.edit().remove("sync.${a.id}.time").commit()
        val manager = androidx.work.WorkManager.getInstance(context)
        val work =
            androidx.work
                .OneTimeWorkRequestBuilder<com.mailai.mobile.background.MailSyncWorker>()
                .build()
        manager
            .enqueueUniqueWork("device-test-sync", androidx.work.ExistingWorkPolicy.REPLACE, work)
            .result
            .get()
        try {
            compose.waitUntil(15000) { prefs.data.getLong("sync.${a.id}.time", 0) > 0 }
            assertFalse(prefs.data.getBoolean("sync.${a.id}.ok", true))
            MailStore(context, a.id).use { assertEquals(draft.body, it.draft(draft.id)?.body) }
        } finally {
            manager.cancelUniqueWork("device-test-sync").result.get()
        }
    }

    @Test
    fun notificationIsPrivateAndOpensExactMail() {
        val a =
            Account(
                id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
                email = "fixture@example.test",
                imap = Server("127.0.0.1", 993),
                smtp = Server("127.0.0.1", 465),
            )
        AccountStore(context).put(a, "synthetic-test-secret")
        if (android.os.Build.VERSION.SDK_INT >= 33)
            InstrumentationRegistry.getInstrumentation()
                .uiAutomation
                .grantRuntimePermission(
                    context.packageName,
                    android.Manifest.permission.POST_NOTIFICATIONS,
                )
        com.mailai.mobile.background.MailNotifications.channels(context)
        com.mailai.mobile.background.AppPreferences(context).previews = false
        val m =
            MailItem(
                "INBOX:1:99",
                "INBOX",
                1,
                99,
                "隐私发件人",
                "a@example.test",
                a.email,
                "不能显示的主题",
                1,
                false,
                "通知点击应当直接展示这封邮件的正文",
            )
        MailStore(context, a.id).use { it.put(m) }
        com.mailai.mobile.background.MailNotifications.show(context, a, listOf(m))
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        compose.waitUntil(5000) { manager.activeNotifications.any { it.tag == "mail.${a.id}" } }
        val notice = manager.activeNotifications.single { it.tag == "mail.${a.id}" }.notification
        assertEquals("MailAI · 有新邮件", notice.extras.getString(android.app.Notification.EXTRA_TITLE))
        assertFalse(notice.extras.toString().contains("不能显示的主题"))
        assertEquals(android.app.Notification.VISIBILITY_PRIVATE, notice.visibility)
        val scenario =
            ActivityScenario.launch<MainActivity>(
                com.mailai.mobile.background.MailNotifications.mailIntent(context, a, m.key)
            )
        try {
            compose.waitUntil(15000) {
                compose.onAllNodesWithText("回复").fetchSemanticsNodes().isNotEmpty()
            }
            scenario.onActivity {
                androidx.lifecycle
                    .ViewModelProvider(it)[com.mailai.mobile.ui.MailViewModel::class.java]
                    .go("boxes")
            }
            compose.onNodeWithText("账号与设置").performScrollTo().performClick()
            compose.waitUntil(15000) {
                compose.onAllNodesWithText("账号与设置").fetchSemanticsNodes().isNotEmpty()
            }
            val device =
                androidx.test.uiautomator.UiDevice.getInstance(
                    InstrumentationRegistry.getInstrumentation()
                )
            device.openNotification()
            val row =
                device.wait(
                    androidx.test.uiautomator.Until.findObject(
                        androidx.test.uiautomator.By.text("MailAI · 有新邮件")
                    ),
                    5000,
                )
            assertNotNull(row)
            row.click()
            compose.waitUntil(15000) {
                compose
                    .onAllNodesWithText(requireNotNull(m.body))
                    .fetchSemanticsNodes()
                    .isNotEmpty()
            }
            compose.onNodeWithText("回复").assertExists()
        } finally {
            // Notification / launcher delivery replaces Activity.intent. Restore only the
            // fixture metadata so ActivityScenario can match lifecycle events during teardown.
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val monitor =
                    androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                listOf(
                        androidx.test.runner.lifecycle.Stage.RESUMED,
                        androidx.test.runner.lifecycle.Stage.STARTED,
                        androidx.test.runner.lifecycle.Stage.PAUSED,
                        androidx.test.runner.lifecycle.Stage.STOPPED,
                    )
                    .flatMap { monitor.getActivitiesInStage(it) }
                    .filterIsInstance<MainActivity>()
                    .forEach {
                        it.intent =
                            com.mailai.mobile.background.MailNotifications.mailIntent(
                                context,
                                a,
                                m.key,
                            )
                    }
            }
            scenario.close()
            manager.cancel("mail.${a.id}", 1)
        }
    }

    @Test
    fun preferencesPersistAndManualUpdateProvidesFeedback() {
        val intent =
            android.content
                .Intent(context, MainActivity::class.java)
                .setAction("com.mailai.OPEN_UPDATES")
        val scenario = ActivityScenario.launch<MainActivity>(intent)
        try {
            compose.waitUntil(15000) {
                compose.onAllNodesWithText("账号与设置").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("完成").performClick()
            compose.onNodeWithText("邮件同步频率").performScrollTo().performClick()
            compose.onNode(hasText("30 分钟") and isSelectable()).performClick()
            assertEquals(30, com.mailai.mobile.background.AppPreferences(context).interval)
            scenario.recreate()
            compose.onNodeWithText("邮件同步频率").performScrollTo().performClick()
            compose.onNode(hasText("30 分钟") and isSelected()).assertExists()
            compose.onNodeWithText("完成").performClick()
            compose.onNodeWithText("应用更新").performScrollTo().performClick()
            compose.onNodeWithText("检查更新").performScrollTo().performClick()
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("正在检查更新…").fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            androidx.work.WorkManager.getInstance(context).cancelUniqueWork("update-check-now")
            scenario.close()
        }
    }

    @Test
    fun cachedReaderAndDraftSurviveActivityRecreation() {
        val a =
            Account(
                id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
                email = "fixture@example.test",
                imap = Server("127.0.0.1", 993),
                smtp = Server("127.0.0.1", 465),
            )
        AccountStore(context).put(a, "synthetic-test-secret")
        MailStore(context, a.id).use { store ->
            store
                .drafts()
                .filter { it.state in setOf(SendState.DRAFT, SendState.FAILED) }
                .forEach { store.discard(it.id) }
            store.put(
                MailItem(
                    "INBOX:1:1",
                    "INBOX",
                    1,
                    1,
                    "许然 <sender@example.test>",
                    "sender@example.test",
                    a.email,
                    "周末出发的行程安排",
                    System.currentTimeMillis(),
                    false,
                    "车票订好了，周六上午出发。\n\n路线和集合地点我再发给你，周五前确认一下就好。",
                )
            )
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: com.mailai.mobile.ui.MailViewModel
        scenario.onActivity {
            vm =
                androidx.lifecycle
                    .ViewModelProvider(it)[com.mailai.mobile.ui.MailViewModel::class.java]
        }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        if (vm.account?.id != a.id) {
            scenario.onActivity { vm.choose(a) }
            compose.waitUntil(15000) { vm.account?.id == a.id && !vm.busy }
        }
        try {
            compose.waitUntil(15000) {
                compose.onAllNodesWithText("周末出发的行程安排").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("周末出发的行程安排").performClick()
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("回复").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("回复").assertIsEnabled().performClick()
            compose.onNodeWithTag("compose-body").performScrollTo().performTextInput("收到，周五前我会确认。")
            compose.waitUntil(10000) {
                MailStore(context, a.id).use { it.drafts().any { d -> d.body == "收到，周五前我会确认。" } }
            }
            scenario.recreate()
            compose.onNodeWithText("收到，周五前我会确认。").assertExists()
            compose.onNode(hasText("‹  返回") or hasContentDescription("返回")).performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { vm.page == "reader" && !vm.busy }
            compose.onNodeWithText("回复").assertExists()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.waitUntil(10000) { vm.page == "inbox" && !vm.busy }
            compose.onNodeWithContentDescription("返回").performClick()
            compose.waitUntil(10000) { vm.page == "boxes" && !vm.busy }
            compose.onNodeWithText("草稿与发送记录").performScrollTo().assertIsDisplayed().performClick()
            compose.waitUntil(10000) { vm.page == "drafts" }
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("Re: 周末出发的行程安排").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Re: 周末出发的行程安排").performClick()
            compose.onNodeWithText("收到，周五前我会确认。").assertExists()
            assertFalse(
                File(context.filesDir, "accounts.json").readText().contains("synthetic-test-secret")
            )
        } finally {
            scenario.close()
        }
    }
}
