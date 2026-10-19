package com.mailai.mobile

import android.app.NotificationManager
import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.work.WorkManager
import com.mailai.mobile.background.*
import com.mailai.mobile.data.*
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Synthetic data only. Xiaomi-specific switches still require the user's actual phone. */
class BackgroundExperienceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val account =
        Account(
            id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
            email = "fixture@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .grantRuntimePermission(
                context.packageName,
                android.Manifest.permission.POST_NOTIFICATIONS,
            )
        val prefs = AppPreferences(context)
        prefs.background = true
        AccountStore(context).put(account, "synthetic-test-secret")
        AccountStore(context).all().forEach { prefs.syncResult(it.id, true) }
        WorkManager.getInstance(context).cancelAllWork().result.get()
        ReadingPreferences(context).theme = "system"
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        if (vm.account?.id != account.id) {
            scenario.onActivity { vm.choose(account) }
            compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy }
        }
        return scenario to vm
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val directory =
            File(context.getExternalFilesDir(null), "background-health-checks").apply { mkdirs() }
        device.takeScreenshot(File(directory, "$name.png"))
    }

    @Test
    fun settingsSeparatePermissionPowerAndActualBackgroundHistoryAndRemainScrollable() {
        val (scenario, vm) = launch()
        try {
            BackgroundHealth(context).started(account.id)
            BackgroundHealth(context).finished(account.id, "dns")
            scenario.onActivity { vm.openNotification(null, true, backgroundSettings = true) }
            compose.onNodeWithTag("background-settings").assertExists()
            compose.onAllNodesWithText("后台收信")[0].assertIsDisplayed()
            compose.onNodeWithText("发送一条测试通知").performScrollTo().assertIsDisplayed().performClick()
            capture("00-notification-settings")
            compose.onNodeWithText("立即检查收信").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("无法解析服务器", substring = true).assertIsDisplayed()
            capture("01-background-history")
            compose.onNodeWithText("完成").performClick()
            compose.onNodeWithTag("background-settings").assertDoesNotExist()
        } finally {
            scenario.close()
        }
    }

    @Test
    fun testNotificationUsesRealMailChannelWithoutAcknowledgingMailAndSavesDraftOnTap() {
        val (scenario, vm) = launch()
        val notices = context.getSystemService(NotificationManager::class.java)
        val repo = (context.applicationContext as MailApplication).repository
        val db = repo.store(account)
        try {
            db.clearMessageCache()
            fun mail(uid: Long) =
                MailItem(
                    "INBOX:1:$uid",
                    "INBOX",
                    1,
                    uid,
                    "fixture sender",
                    "sender@example.test",
                    account.email,
                    "synthetic mail $uid",
                    System.currentTimeMillis(),
                    true,
                    "cached body",
                )
            db.put(mail(901))
            db.recordArrivals(1, listOf(mail(900)))
            db.recordArrivals(1, listOf(mail(901)))
            assertEquals(1, db.pendingArrivals().size)
            assertTrue(MailNotifications.test(context))
            val notification =
                notices.activeNotifications.single { it.tag == "mail-test" }.notification
            assertEquals(MailNotifications.CHANNEL, notification.channelId)
            assertEquals(1, db.pendingArrivals().size)
            val draft = Draft(body = "通知跳转不能丢失编辑")
            db.save(draft)
            scenario.onActivity {
                vm.openDraft(draft)
                vm.update(draft.copy(body = "最后输入的一行"))
            }
            notification.contentIntent.send()
            compose.waitUntil(15000) { vm.page == "settings" }
            compose.onNodeWithTag("background-settings").assertExists()
            assertEquals("最后输入的一行", db.draft(draft.id)?.body)
            capture("02-test-notification-navigation")
        } finally {
            notices.cancel("mail-test", 3)
            // ActivityScenario matches lifecycle events against its launch intent.
            // A real notification replaces Activity.intent; restore it before closing the fixture.
            scenario.onActivity {
                it.intent =
                    Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_LAUNCHER)
                        .setClass(context, MainActivity::class.java)
            }
            scenario.close()
        }
    }

    @Test
    fun unsupportedVendorSettingsGracefullyFallBackToAppInformation() {
        val (scenario, _) = launch()
        try {
            assertTrue(BackgroundAccess.open(context, "autostart"))
            device.waitForIdle(1000)
            assertNotEquals(context.packageName, device.currentPackageName)
            device.pressBack()
        } finally {
            scenario.close()
        }
    }
}
