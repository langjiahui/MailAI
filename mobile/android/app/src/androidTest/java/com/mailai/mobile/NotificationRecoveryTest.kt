package com.mailai.mobile

import android.app.NotificationManager
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.work.*
import com.mailai.mobile.background.*
import com.mailai.mobile.data.*
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Uses only the owned emulator and synthetic mail; restores every power override in finally. */
@RunWith(AndroidJUnit4::class)
class NotificationRecoveryTest {
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

    private fun mail(uid: Long) =
        MailItem(
            "INBOX:1:$uid",
            "INBOX",
            1,
            uid,
            "合成通知发件人",
            "sender@example.test",
            account.email,
            "通知定位 $uid",
            System.currentTimeMillis(),
            false,
            "只属于邮件 $uid 的正文",
        )

    private fun await(timeout: Long = 20000, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout)
        while (!condition()) {
            check(System.nanoTime() < deadline) { "Condition timed out" }
            Thread.sleep(100)
        }
    }

    @Test
    fun lockedBatterySaverRetainsOrDeliversQueueAndRetriesDoNotDuplicate() {
        AccountStore(context).put(account, "synthetic-test-secret")
        val prefs = AppPreferences(context)
        prefs.background = true
        prefs.previews = false
        prefs.syncResult(
            account.id,
            true,
        ) // Catch-up can deliver locally without a test SMTP/IMAP server.
        // Other synthetic accounts may exist from earlier cases; this case tests local
        // delivery, not network authentication against their deliberately closed ports.
        AccountStore(context).all().forEach { prefs.syncResult(it.id, true) }
        MailNotifications.channels(context)
        InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .grantRuntimePermission(
                context.packageName,
                android.Manifest.permission.POST_NOTIFICATIONS,
            )
        val manager = WorkManager.getInstance(context)
        manager.cancelAllWork().result.get()
        val notices = context.getSystemService(NotificationManager::class.java)
        notices.cancelAll()
        val db = (context.applicationContext as MailApplication).repository.store(account)
        db.clearMessageCache()
        val arrival = mail(702).copy(unread = true)
        db.put(arrival)
        db.recordArrivals(1, listOf(mail(701)))
        db.recordArrivals(1, listOf(arrival))
        val preparing =
            InstrumentationRegistry.getArguments().getString("mailaiDozeStage") == "prepare"
        val work =
            OneTimeWorkRequestBuilder<MailSyncWorker>()
                .setInitialDelay(if (preparing) 15L else 0L, TimeUnit.SECONDS)
                .setInputData(workDataOf("catchUp" to true))
                .setConstraints(BackgroundSchedule.mailConstraints())
                .build()
        if (preparing) {
            manager.enqueue(work).result.get()
            val dir =
                File(context.getExternalFilesDir(null), "notification-checks").apply { mkdirs() }
            File(dir, "doze-work-id.txt").writeText(work.id.toString())
            return // Host kills this fixture process and probes the real JobScheduler in Doze.
        }
        val deepEnabled =
            device.executeShellCommand("dumpsys deviceidle enabled deep").trim() == "1"
        try {
            device.executeShellCommand("dumpsys deviceidle enable deep")
            device.pressHome()
            device.executeShellCommand("dumpsys battery unplug")
            device.executeShellCommand("cmd power set-mode 1")
            device.sleep()
            val idle = device.executeShellCommand("dumpsys deviceidle force-idle")
            assertTrue(idle, idle.contains("idle", ignoreCase = true))
            assertTrue(device.executeShellCommand("dumpsys deviceidle get deep").contains("IDLE"))
            manager.enqueue(work).result.get()
            Thread.sleep(2500)
            // Instrumentation can keep this process active, allowing WorkManager's in-process
            // scheduler to deliver local data in Doze. The host probe separately tests a dead
            // process.
            val idleState = manager.getWorkInfoById(work.id).get()?.state
            assertTrue(
                idleState in
                    setOf(WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.SUCCEEDED)
            )
            assertTrue(
                db.pendingArrivals().isNotEmpty() ||
                    notices.activeNotifications.any { it.tag == "mail.${account.id}" }
            )
            device.executeShellCommand("dumpsys deviceidle unforce")
            device.executeShellCommand("cmd power set-mode 0")
            device.executeShellCommand("dumpsys battery reset")
            device.wakeUp()
            device.executeShellCommand("wm dismiss-keyguard")
            await(30000) {
                manager.getWorkInfoById(work.id).get()?.state == WorkInfo.State.SUCCEEDED
            }
            await { notices.activeNotifications.any { it.tag == "mail.${account.id}" } }
            assertTrue(db.pendingArrivals().isEmpty())
            val first = notices.activeNotifications.single { it.tag == "mail.${account.id}" }
            assertEquals(android.app.Notification.VISIBILITY_PRIVATE, first.notification.visibility)
            assertFalse(first.notification.extras.toString().contains(arrival.subject))
            repeat(3) {
                val retry =
                    OneTimeWorkRequestBuilder<MailSyncWorker>()
                        .setInputData(workDataOf("catchUp" to true))
                        .build()
                manager.enqueue(retry).result.get()
                await { manager.getWorkInfoById(retry.id).get()?.state == WorkInfo.State.SUCCEEDED }
            }
            val after = notices.activeNotifications.single { it.tag == "mail.${account.id}" }
            assertEquals(first.postTime, after.postTime) // No repost after acknowledgement.
            device.openNotification()
            device.waitForIdle(1000)
            val dir =
                File(context.getExternalFilesDir(null), "notification-checks").apply { mkdirs() }
            device.takeScreenshot(File(dir, "after-doze-one-notification.png"))
            device.pressBack()
        } finally {
            device.executeShellCommand("dumpsys deviceidle unforce")
            device.executeShellCommand("cmd power set-mode 0")
            device.executeShellCommand("dumpsys battery reset")
            device.wakeUp()
            device.executeShellCommand("wm dismiss-keyguard")
            if (!deepEnabled) device.executeShellCommand("dumpsys deviceidle disable deep")
            manager.cancelAllWork().result.get()
            notices.cancelAll()
        }
    }

    @Test
    fun notificationNavigationSavesComposerAndMissingKeyNeverOpensAnotherMail() {
        AccountStore(context).put(account, "synthetic-test-secret")
        val target = mail(801)
        val other = mail(802)
        val repo = (context.applicationContext as MailApplication).repository
        repo.store(account).put(target)
        repo.store(account).put(other)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        try {
            scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            if (vm.account?.id != account.id) {
                scenario.onActivity { vm.choose(account) }
                compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy }
            }
            val draft = Draft(body = "通知到来时正在编辑")
            repo.store(account).save(draft)
            scenario.onActivity {
                vm.openDraft(draft)
                vm.update(draft.copy(body = "通知跳转前的最后一行"))
                vm.openNotification(account.id, false, target.key)
            }
            compose.waitUntil(15000) { vm.page == "reader" && !vm.busy }
            assertEquals(target.key, vm.selected?.key)
            assertEquals(target.body, vm.selected?.body)
            assertEquals("通知跳转前的最后一行", repo.store(account).draft(draft.id)?.body)
            scenario.onActivity { vm.openNotification(account.id, false, "INBOX:1:999999") }
            compose.waitUntil(10000) { vm.page == "inbox" && vm.error }
            assertNull(vm.selected)
            assertTrue(vm.status.contains("已移出本地列表"))
            assertTrue(vm.canRetry)
            scenario.onActivity { vm.openNotification("unavailable-account", false, other.key) }
            compose.waitUntil(10000) { vm.status.contains("邮箱已不可用") }
            assertNull(vm.selected)
        } finally {
            scenario.close()
        }
    }
}
