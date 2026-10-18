package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.Operation
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic local data, actual Android network toggles and activity lifecycle. */
@RunWith(AndroidJUnit4::class)
class BackgroundRecoveryTest {
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
        AccountStore(context).put(account, "synthetic-test-secret")
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        return scenario to vm
    }

    private fun network(enabled: Boolean) {
        device.executeShellCommand("svc wifi ${if (enabled) "enable" else "disable"}")
        device.executeShellCommand("svc data ${if (enabled) "enable" else "disable"}")
        if (enabled) device.executeShellCommand("cmd wifi connect-network AndroidWifi open")
    }

    private fun attachment(repo: MailRepository): Attachment = runBlocking {
        val source = File(context.cacheDir, "background-original.txt").apply { writeText("离线附件原文") }
        val result = repo.import(account, android.net.Uri.fromFile(source), Operation())
        assertTrue(source.delete())
        result
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(1000)
        val directory = File(context.getExternalFilesDir(null), "network-checks").apply { mkdirs() }
        device.takeScreenshot(File(directory, "$name.png"))
    }

    @Test
    fun offlineDraftAndAttachmentSurviveBackgroundAndReconnectNeverSends() {
        val (scenario, vm) = launch()
        try {
            val file = attachment(vm.repo)
            val draft =
                Draft(
                    subject = "后台恢复测试",
                    to = "receiver@example.test",
                    body = "后台前的正文",
                    attachments = listOf(file),
                )
            vm.repo.store(account).save(draft)
            scenario.onActivity { vm.openDraft(draft) }
            compose
                .onNodeWithTag("compose-body")
                .performScrollTo()
                .performClick()
                .performTextReplacement("断网时继续写下的最后一行")
            network(false)
            compose.waitUntil(15000) { !vm.online }
            device.pressBack() // keyboard
            scenario.moveToState(Lifecycle.State.CREATED)
            compose.waitUntil(10000) {
                vm.repo.store(account).draft(draft.id)?.body == "断网时继续写下的最后一行"
            }
            scenario.moveToState(Lifecycle.State.RESUMED)
            assertEquals("compose", vm.page)
            assertEquals(draft.id, vm.draft?.id)
            assertEquals("断网时继续写下的最后一行", vm.draft?.body)
            assertEquals("离线附件原文", vm.repo.file(account, file.local).readText())
            compose.onNodeWithText("当前离线 · 可以阅读缓存、继续写草稿").assertIsDisplayed()
            scenario.onActivity {
                vm.send()
                vm.send()
            }
            compose.waitUntil(10000) { !vm.busy && vm.error }
            assertEquals(SendState.DRAFT, vm.repo.store(account).draft(draft.id)?.state)
            assertTrue(vm.status.startsWith("未提交成功"))
            assertFalse(vm.canRetry) // Sending still requires an explicit review and confirmation.
            capture("offline-send-preserved")
            network(true)
            compose.waitUntil(20000) { vm.online }
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            compose.waitForIdle()
            assertFalse(vm.busy)
            assertEquals(SendState.DRAFT, vm.repo.store(account).draft(draft.id)?.state)
            assertEquals("断网时继续写下的最后一行", vm.draft?.body)
            capture("reconnected-draft")
        } finally {
            network(true)
            scenario.close()
        }
    }

    @Test
    fun cachedMailAndDownloadedAttachmentRemainUsableOffline() {
        val (scenario, vm) = launch()
        try {
            val file = attachment(vm.repo)
            val mail =
                MailItem(
                    "INBOX:1:501",
                    "INBOX",
                    1,
                    501,
                    "离线发件人",
                    "sender@example.test",
                    account.email,
                    "断网后仍能阅读",
                    System.currentTimeMillis(),
                    true,
                    "已经下载的正文不能因网络切换消失。",
                    listOf(file),
                )
            vm.repo.store(account).put(mail)
            network(false)
            compose.waitUntil(15000) { !vm.online }
            scenario.onActivity { vm.read(mail) }
            compose.waitUntil(10000) { !vm.busy }
            assertFalse(vm.error)
            compose.onNodeWithText(requireNotNull(mail.body)).assertExists()
            compose.onNodeWithText("回复").assertIsEnabled()
            scenario.onActivity { vm.download(file) }
            compose.waitUntil(10000) { vm.availableFile != null && !vm.busy }
            assertFalse(vm.error)
            assertEquals(
                "离线附件原文",
                vm.repo.file(account, requireNotNull(vm.availableFile).second.local).readText(),
            )
            scenario.onActivity {
                vm.availableFile = null
                vm.refresh()
            }
            compose.waitUntil(10000) { !vm.busy && vm.error }
            assertEquals(
                mail.body,
                vm.repo.store(account).messages("INBOX").single { it.key == mail.key }.body,
            )
            capture("offline-reader")
        } finally {
            network(true)
            scenario.close()
        }
    }

    @Test
    fun uncertainSendRemainsLockedAfterBackgroundAndRecreation() {
        val (scenario, vm) = launch()
        try {
            val draft = Draft(subject = "待确认发送测试", to = "receiver@example.test", body = "绝不能自动重发")
            val store = vm.repo.store(account)
            store.save(draft)
            store.beginSend(draft)
            store.transition(draft.id, setOf(SendState.CONNECTING), SendState.TRANSMITTING)
            store.transition(draft.id, setOf(SendState.TRANSMITTING), SendState.UNCERTAIN)
            scenario.onActivity { vm.openDraft(requireNotNull(store.draft(draft.id))) }
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            scenario.recreate()
            compose.onNodeWithText("发送").assertIsNotEnabled()
            scenario.onActivity {
                vm.send()
                vm.update(draft.copy(body = "过期的编辑快照"))
            }
            assertEquals(SendState.UNCERTAIN, store.draft(draft.id)?.state)
            assertEquals("绝不能自动重发", vm.draft?.body)
            assertFalse(vm.busy)
            // A stale editor snapshot must be corrected from the durable record on failure.
            scenario.onActivity {
                vm.openDraft(draft)
                vm.send()
            }
            compose.waitUntil(10000) { !vm.busy && vm.error }
            assertEquals(SendState.UNCERTAIN, vm.draft?.state)
            assertTrue(vm.status.contains("待确认"))
            compose.onNodeWithText("发送").assertIsNotEnabled()
            capture("uncertain-locked")
        } finally {
            scenario.close()
        }
    }

    @Test
    fun failedDraftWriteKeepsEditorContentAndOffersSuccessfulRetry() {
        val (scenario, vm) = launch()
        val db = vm.repo.store(account).writableDatabase
        try {
            val d = Draft(subject = "保存失败重试测试", body = "原先已保存")
            vm.repo.store(account).save(d)
            scenario.onActivity { vm.openDraft(d) }
            db.execSQL(
                "CREATE TRIGGER test_draft_write_failure BEFORE INSERT ON drafts WHEN NEW.id='${d.id}' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END"
            )
            scenario.onActivity { vm.update(d.copy(body = "必须留在编辑器里的新内容")) }
            compose.waitUntil(10000) { vm.saveStatus.startsWith("保存失败") && vm.error }
            assertEquals("必须留在编辑器里的新内容", vm.draft?.body)
            assertEquals("原先已保存", vm.repo.store(account).draft(d.id)?.body)
            compose.onNodeWithText("重试").assertIsDisplayed()
            capture("draft-save-failed")
            db.execSQL("DROP TRIGGER test_draft_write_failure")
            compose.onNodeWithText("重试").performClick()
            compose.waitUntil(10000) { !vm.busy && !vm.error && vm.saveStatus == "草稿已保存在此设备" }
            assertEquals("必须留在编辑器里的新内容", vm.repo.store(account).draft(d.id)?.body)
        } finally {
            db.execSQL("DROP TRIGGER IF EXISTS test_draft_write_failure")
            scenario.close()
        }
    }
}
