package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.mailai.mobile.data.*
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real UI actions with synthetic data; no external messages or passwords. */
@RunWith(AndroidJUnit4::class)
class EverydayInteractionTest {
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
    private val mail =
        MailItem(
            "INBOX:1:9",
            "INBOX",
            1,
            9,
            "林安 <lin@example.test>",
            "lin@example.test",
            account.email,
            "项目沟通",
            System.currentTimeMillis(),
            false,
            "请确认周五下午三点的时间。",
        )
    private val draft =
        Draft(id = "everyday-draft", to = "lin@example.test", subject = "待补充资料", body = "资料还在整理中。")

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        AccountStore(context).put(account, "synthetic-test-secret")
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
            it.put(mail)
            it.save(draft)
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        if (vm.account?.id != account.id) {
            scenario.onActivity { vm.choose(account) }
            compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy }
        }
        scenario.onActivity {
            vm.dismissStatus()
            vm.go("inbox")
        }
        return scenario to vm
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(1000)
        val folder = File(context.getExternalFilesDir(null), "everyday-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(folder, "$name.png")))
    }

    private fun cleanup(scenario: ActivityScenario<MainActivity>) {
        scenario.close()
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
        }
    }

    private fun confirmSave(vm: MailViewModel, destination: String) {
        device.pressBack() // Hide IME, if visible.
        if (
            vm.page == "compose" &&
                compose.onAllNodesWithText("保存并返回").fetchSemanticsNodes().isEmpty()
        )
            compose.onNode(hasText("‹  返回") or hasContentDescription("返回")).performClick()
        compose.onNodeWithText("保存并返回").performClick()
        compose.waitUntil(10000) { vm.page == destination && !vm.busy }
    }

    @Test
    fun replyReturnsToOriginalMailAfterRecreationAndPreservesBody() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithText(mail.subject).performClick()
            compose.onNodeWithText("回复").performClick()
            compose.onNodeWithTag("compose-body").performScrollTo().performTextInput("时间可以，周五见。")
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            scenario.recreate()
            confirmSave(vm, "reader")
            compose.onNodeWithText(mail.subject).assertIsDisplayed()
            compose.onNodeWithText(mail.body!!).performScrollTo().assertIsDisplayed()
            MailStore(context, account.id).use {
                assertTrue(it.drafts().any { d -> d.body == "时间可以，周五见。" })
            }
            capture("reply-return-reader")
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun oldDraftReturnsToRecordsAndDiscardDoesNotRemoveOtherDrafts() {
        val (scenario, vm) = launch()
        try {
            val other = Draft(id = "everyday-other", subject = "另一封草稿", body = "必须保留")
            MailStore(context, account.id).use { it.save(other) }
            scenario.onActivity { vm.go("drafts") }
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(draft.subject))
            compose.onNodeWithText(draft.subject).performClick()
            compose.onNodeWithTag("compose-body").performScrollTo().performTextInput("明天补齐。")
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            confirmSave(vm, "drafts")
            compose.onNodeWithContentDescription("返回").assertIsDisplayed()
            assertEquals("drafts", vm.page)
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(draft.subject))
            compose.onNodeWithText(draft.subject).assertExists()
            capture("draft-return-records")
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(draft.subject))
            compose.onNodeWithText(draft.subject).performClick()
            compose.onNode(hasText("‹  返回") or hasContentDescription("返回")).performClick()
            compose.onNodeWithText("放弃草稿").performClick()
            compose.waitUntil(10000) { !vm.busy && vm.page == "drafts" }
            MailStore(context, account.id).use {
                assertNull(it.draft(draft.id))
                assertEquals(other.body, it.draft(other.id)?.body)
            }
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun emptySearchAndUnreadFilterHaveOneTapRecovery() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("open-search").performClick()
            compose.onNodeWithTag("mail-search").performTextInput("没有这个主题")
            compose.onNodeWithTag("mail-search").performImeAction()
            compose.waitUntil(5000) {
                compose.onAllNodesWithText("没有匹配的邮件").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("没有匹配的邮件", useUnmergedTree = true).assertIsDisplayed()
            capture("search-empty")
            compose.onNodeWithText("查看全部邮件").performClick()
            compose.onNodeWithText(mail.subject).assertExists()
            compose.onNodeWithTag("inbox-filter").performClick()
            compose.onNodeWithTag("filter-unread").performClick()
            compose.onNodeWithTag("inbox-list").performScrollToNode(hasText("暂无未读邮件"))
            compose.onNodeWithText("暂无未读邮件", useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithTag("inbox-list").performScrollToNode(hasText("查看全部邮件"))
            compose.onNodeWithText("查看全部邮件").performClick()
            compose.onNodeWithText(mail.subject).assertExists()
            assertFalse(vm.unreadOnly)
            assertEquals("", vm.query)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun restoredComposerReturnsToSourceOrInboxIfSourceWasRemoved() {
        val (scenario, _) = launch()
        try {
            for (sourcePresent in listOf(true, false)) {
                if (!sourcePresent)
                    MailStore(context, account.id).use {
                        it.writableDatabase.delete("messages", null, null)
                    }
                lateinit var restored: MailViewModel
                val store = androidx.lifecycle.ViewModelStore()
                scenario.onActivity {
                    restored =
                        MailViewModel(
                            context.applicationContext as android.app.Application,
                            androidx.lifecycle.SavedStateHandle(
                                mapOf(
                                    "composerOrigin" to "reader",
                                    "location" to
                                        arrayOf("compose", account.id, "INBOX", draft.id, mail.key),
                                )
                            ),
                        )
                    store.put("restored-composer", restored)
                }
                try {
                    compose.waitUntil(10000) { restored.ready }
                    assertEquals("compose", restored.page)
                    assertEquals(draft.body, restored.draft?.body)
                    scenario.onActivity { restored.saveAndLeave() }
                    compose.waitUntil(10000) { !restored.busy && restored.page != "compose" }
                    assertEquals(if (sourcePresent) "reader" else "inbox", restored.page)
                    if (sourcePresent) assertEquals(mail.key, restored.selected?.key)
                } finally {
                    scenario.onActivity { store.clear() }
                }
            }
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun floatingFeedbackExpiresWhileFailureKeepsRetryAction() {
        val (scenario, vm) = launch()
        try {
            // Local connection failure should remain available beyond the success timeout.
            scenario.onActivity { vm.refresh() }
            compose.waitUntil(10000) { !vm.busy && vm.error }
            compose.mainClock.advanceTimeBy(4500)
            compose.onNodeWithContentDescription("重试同步").assertExists()
            assertTrue(vm.status.isNotBlank())
            scenario.onActivity {
                vm.dismissStatus()
                vm.compose()
            }
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            compose.onNode(hasText("‹  返回") or hasContentDescription("返回")).performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { vm.page == "inbox" && !vm.busy }
            compose.mainClock.advanceTimeBy(4500)
            compose.waitUntil(6000) { vm.status.isBlank() }
        } finally {
            cleanup(scenario)
        }
    }
}
