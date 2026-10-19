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

/** Native screenshots and navigation regression; only local synthetic mail, never SMTP. */
@RunWith(AndroidJUnit4::class)
class DesignNavigationTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val account =
        Account(
            id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
            name = "工作邮箱",
            email = "fixture@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )
    private val subjects =
        listOf("周五项目沟通安排", "设计稿确认", "周末出发的行程安排", "本周进度同步", "报销材料补充", "下周协作事项", "项目资料归档")
    private val senders = listOf("林安", "陈予", "许然", "产品团队", "财务", "周宁", "顾青")
    private val bodies =
        listOf(
            "会议时间调整至下午三点，材料已附上。",
            "这一版的布局已经更新，请查收。",
            "车票订好了，周六上午出发。",
            "本周的重点与待确认事项。",
            "请补充附件中的信息。",
            "期待与你一起推进。",
            "文件已整理完成，供后续参考。",
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        AccountStore(context).put(account, "synthetic-test-secret")
        MailStore(context, account.id).use { store ->
            store.writableDatabase.delete("messages", null, null)
            store.writableDatabase.delete("drafts", null, null)
            repeat(30) { i ->
                store.put(
                    MailItem(
                        "INBOX:1:${i + 1}",
                        "INBOX",
                        1,
                        (i + 1).toLong(),
                        "${senders[i % 7]} <sender@example.test>",
                        "sender@example.test",
                        account.email,
                        if (i < 7) subjects[i] else "归档资料 ${i + 1}",
                        System.currentTimeMillis() - i * 600000L,
                        false,
                        "${bodies[i % 7]}\n\n路线和集合地点我再发给你，周五前确认一下就好。",
                        if (i == 0) listOf(Attachment("1", "项目沟通材料.pdf", "application/pdf", 327680))
                        else emptyList(),
                    )
                )
            }
            store.save(
                Draft(
                    id = "design-editable",
                    to = "lin@example.test",
                    subject = "周五见面时间",
                    body = "下午三点可以，材料我会提前看完。",
                )
            )
            store.save(
                Draft(
                    id = "design-failed",
                    to = "lin@example.test",
                    subject = "补充说明",
                    body = "附件资料已经整理完成。",
                    state = SendState.FAILED,
                )
            )
            store.beginSend(
                Draft(
                    id = "design-uncertain",
                    to = "lin@example.test",
                    subject = "项目进度确认",
                    body = "等待核查发件服务器的实际结果。",
                )
            )
            store.transition("design-uncertain", setOf(SendState.CONNECTING), SendState.UNCERTAIN)
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        scenario.onActivity {
            vm.dismissStatus()
            vm.go("inbox")
        }
        compose.waitForIdle()
        return scenario to vm
    }

    private fun cleanFixture() {
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        if (compose.mainClock.autoAdvance) device.waitForIdle(1000)
        val folder = File(context.getExternalFilesDir(null), "design-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(folder, "$name.png")))
    }

    @Test
    fun allSevenPagesAndProtectedDraftRemainUsable() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithText("MailAI").assertDoesNotExist()
            capture("03-inbox")
            compose.onNodeWithText(subjects[0]).performClick()
            compose.onNodeWithText("回复").assertIsDisplayed()
            assertFalse("Cached read mail must not flash a network loading operation", vm.busy)
            capture("04-reader")
            compose.onNodeWithText("回复").performClick()
            compose.onNodeWithText("收件人").performScrollTo().assertExists()
            compose
                .onNodeWithTag("compose-body")
                .performScrollTo()
                .performTextInput("你好，林安：\n\n时间没问题，我会提前看完材料。\n\n周五见。")
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            compose.onNodeWithText("发送").assertIsDisplayed()
            capture("05-compose-keyboard")
            device.pressBack()
            compose.onNodeWithText("‹  返回").performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { vm.page == "reader" && !vm.busy }
            compose.onNodeWithText("‹  收件箱").performClick()
            compose.onNodeWithText("‹  邮箱").performClick()
            capture("02-mailboxes")
            compose.onNodeWithText("草稿与发送记录").performScrollTo().performClick()
            capture("06-drafts")
            scenario.onActivity { vm.openDraft(vm.drafts.single { it.id == "design-uncertain" }) }
            compose.onNodeWithText("发送").assertIsNotEnabled()
            assertEquals(SendState.UNCERTAIN, vm.draft?.state)
            compose.onNodeWithText("‹  返回").performClick()
            compose.waitUntil(10000) { vm.page == "drafts" }
            compose.onNodeWithText("‹  邮箱").performClick()
            compose.onNodeWithText("通知与更新").performScrollTo().performClick()
            capture("07-settings")
            compose.onNodeWithText("应用更新").performScrollTo().assertIsDisplayed()
            capture("07-settings-updates")
            scenario.onActivity { vm.go("add") }
            capture("01-add-account")
        } finally {
            scenario.close()
            cleanFixture()
        }
    }

    @Test
    fun intermediateTransitionKeepsMailVisibleAndBackRestoresListPosition() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("inbox-list").performScrollToIndex(12)
            val subject = "归档资料 12"
            val before = compose.onNodeWithText(subject).getUnclippedBoundsInRoot().top.value
            compose.mainClock.autoAdvance = false
            compose.onNodeWithText(subject).performClick()
            compose.mainClock.advanceTimeBy(112)
            compose.onNodeWithText("回复").assertExists()
            compose.onNodeWithText(vm.selected!!.body!!).assertExists()
            capture("transition-reader-midpoint")
            compose.mainClock.advanceTimeBy(400)
            compose.mainClock.autoAdvance = true
            compose.onNodeWithText("‹  收件箱").performClick()
            val after = compose.onNodeWithText(subject).getUnclippedBoundsInRoot().top.value
            assertEquals("Returning from mail must preserve exact list position", before, after, 1f)
            // Repeated navigation callbacks cannot replace a newly created draft.
            scenario.onActivity {
                vm.compose()
                val id = vm.draft!!.id
                vm.compose()
                assertEquals(id, vm.draft!!.id)
            }
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            scenario.recreate()
            compose.onNodeWithText("写邮件").assertExists()
            compose.onNodeWithText("发送").assertIsDisplayed()
        } finally {
            compose.mainClock.autoAdvance = true
            scenario.close()
            cleanFixture()
        }
    }
}
