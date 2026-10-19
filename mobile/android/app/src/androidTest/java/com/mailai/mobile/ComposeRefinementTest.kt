package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.text.TextRange
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

@OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ComposeRefinementTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val account =
        Account(
            id = "7bc2ccfe-5adc-4fea-8cb4-d22fda6f3700",
            email = "writer@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )

    private fun assertControlProportions() {
        val root = compose.onRoot().getUnclippedBoundsInRoot()
        val send =
            compose.onNodeWithTag("compose-send").assertIsDisplayed().getUnclippedBoundsInRoot()
        val title =
            if (compose.onAllNodesWithTag("compose-title").fetchSemanticsNodes().isNotEmpty())
                compose.onNodeWithTag("compose-title").getUnclippedBoundsInRoot()
            else null
        assertTrue(
            "Send must remain a horizontal button",
            (send.right - send.left) >= (send.bottom - send.top),
        )
        assertTrue(
            "Send stays within the viewport",
            send.right <= root.right && send.left >= root.left,
        )
        assertTrue("Title must not overlap send", title == null || title.right <= send.left)
        val photo =
            compose.onNodeWithTag("compose-photo").assertIsDisplayed().getUnclippedBoundsInRoot()
        val attachment =
            compose
                .onNodeWithTag("compose-attachment")
                .assertIsDisplayed()
                .getUnclippedBoundsInRoot()
        assertTrue("Bottom actions must not overlap", photo.right <= attachment.left)
        listOf(send, photo, attachment).forEach {
            assertTrue(
                "Touch targets remain at least 48dp: $it",
                (it.right - it.left).value >= 47.5f && (it.bottom - it.top).value >= 47.5f,
            )
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(1000)
        assertControlProportions()
        val dir = File(context.getExternalFilesDir(null), "compose-refinement").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun formatUndoCopiesAndReopenedDraftRetainActualContent() {
        AccountStore(context).put(account, "synthetic-test-secret")
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        try {
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            scenario.onActivity {
                vm.dismissStatus()
                vm.choose(account)
            }
            compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy && vm.error }
            scenario.onActivity {
                vm.compose()
                vm.update(vm.draft!!.copy(to = "同事 <person@example.test>", subject = "周五项目沟通安排"))
            }
            compose.onNodeWithText("抄送 / 密送").performScrollTo().performClick()
            compose
                .onNodeWithTag("compose-cc")
                .performScrollTo()
                .performTextInput("cc@example.test")
            compose
                .onNodeWithTag("compose-bcc")
                .performScrollTo()
                .performTextInput("hidden@example.test")
            compose
                .onNodeWithTag("compose-body")
                .performScrollTo()
                .performClick()
                .performTextInput("你好，团队。请确认周五安排。")
            compose.onNodeWithTag("compose-body").performTextInputSelection(TextRange(0, 2))
            compose.onNodeWithContentDescription("加粗").performScrollTo()
            device.waitForIdle(1000)
            compose.onNodeWithContentDescription("加粗").performClick()
            compose.waitUntil(5000) {
                vm.draft!!.styles.any {
                    it.kind == BodyStyleKind.BOLD && it.start == 0 && it.end == 2
                }
            }
            capture("01-format-and-keyboard")
            compose.onNodeWithContentDescription("撤销").performScrollTo().performClick()
            compose.waitUntil(5000) { vm.draft!!.styles.isEmpty() }
            compose.onNodeWithContentDescription("重做").performClick()
            compose.waitUntil(5000) { vm.draft!!.styles.isNotEmpty() }
            device.pressBack()
            scenario.recreate()
            compose.waitUntil(10000) { vm.ready && !vm.busy }
            compose
                .onNodeWithTag("compose-body")
                .performScrollTo()
                .assertTextContains("你好，团队。请确认周五安排。")
            compose.onNodeWithTag("compose-back").performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { !vm.busy && vm.page == "inbox" }
            val id = vm.draft!!.id
            val saved = MailStore(context, account.id).use { it.draft(id)!! }
            assertEquals("cc@example.test", saved.cc)
            assertEquals("hidden@example.test", saved.bcc)
            assertEquals("你好，团队。请确认周五安排。", saved.body)
            assertEquals(listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)), saved.styles)
            scenario.onActivity { vm.openDraft(saved) }
            compose.onNodeWithTag("compose-body").performScrollTo().assertTextContains(saved.body)
            capture("02-reopened-compose")
            compose.onNodeWithText("收起抄送 / 密送").performScrollTo().performClick()
            compose.onNodeWithTag("compose-recipient-summary-to").performScrollTo()
            capture("04-compose-overview")
        } finally {
            scenario.close()
        }
    }

    @Test
    fun caretFormattingLinkAndCancelKeepTheText() {
        AccountStore(context).put(account, "synthetic-test-secret")
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        try {
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            scenario.onActivity {
                vm.dismissStatus()
                vm.choose(account)
            }
            compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy && vm.error }
            scenario.onActivity { vm.compose() }
            compose.onNodeWithTag("compose-body").performScrollTo().performClick()
            compose.onNodeWithContentDescription("加粗").performScrollTo()
            device.waitForIdle(1000)
            compose.onNodeWithContentDescription("加粗").performClick()
            compose.onNodeWithTag("compose-body").performTextInput("会议")
            compose.onNodeWithContentDescription("加粗").performScrollTo()
            device.waitForIdle(1000)
            compose.onNodeWithContentDescription("加粗").performClick()
            compose.onNodeWithTag("compose-body").performTextInput("安排")
            compose.waitUntil(5000) { vm.draft!!.body == "会议安排" }
            assertEquals(listOf(BodyStyle(0, 2, BodyStyleKind.BOLD)), vm.draft!!.styles)
            compose.onNodeWithTag("compose-body").performTextInputSelection(TextRange(0, 2))
            compose.onNodeWithText("链接").performScrollTo().performClick()
            compose.onNodeWithText("取消").performClick()
            assertEquals("会议安排", vm.draft!!.body)
            compose.onNodeWithText("链接").performClick()
            compose
                .onNodeWithText("HTTPS 链接")
                .performTextReplacement("https://example.test/meeting")
            compose.onNodeWithText("插入").performClick()
            compose.waitUntil(5000) { vm.draft!!.styles.any { it.kind == BodyStyleKind.LINK } }
            assertEquals("会议安排", vm.draft!!.body)
            assertEquals(
                "https://example.test/meeting",
                vm.draft!!.styles.single { it.kind == BodyStyleKind.LINK }.value,
            )
            compose.onNodeWithTag("compose-body").performTextInputSelection(TextRange(0, 4))
            compose.onNodeWithContentDescription("字号").performScrollTo().performClick()
            compose.onNodeWithText("18 号").performClick()
            compose.onNodeWithContentDescription("文字颜色").performScrollTo().performClick()
            compose.onNodeWithText("墨黑").performClick()
            compose.waitUntil(5000) {
                vm.draft!!.styles.any { it.kind == BodyStyleKind.SIZE && it.value == "18" } &&
                    vm.draft!!.styles.any {
                        it.kind == BodyStyleKind.COLOR && it.value == "#122338"
                    }
            }
            capture("03-link-and-formatting")
        } finally {
            scenario.close()
        }
    }
}
