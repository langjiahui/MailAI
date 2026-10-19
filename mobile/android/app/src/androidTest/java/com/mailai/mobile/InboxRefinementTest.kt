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

/** Synthetic mail only. Exercises the compact search/filter and unobstructed bottom row. */
@RunWith(AndroidJUnit4::class)
class InboxRefinementTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val account =
        Account(
            id = "beab59e7-7d74-474a-8941-cd2dc46211a0",
            email = "design@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(1000)
        val folder = File(context.getExternalFilesDir(null), "inbox-refinement").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(folder, "$name.png")))
    }

    @Test
    fun filterSearchKeyboardAndLastRowRemainUsable() {
        AccountStore(context).put(account, "synthetic-test-secret")
        MailStore(context, account.id).use { store ->
            store.writableDatabase.delete("messages", null, null)
            repeat(14) { i ->
                store.put(
                    MailItem(
                        key = "INBOX:1:${i + 1}",
                        folder = "INBOX",
                        validity = 1,
                        uid = (i + 1).toLong(),
                        sender =
                            listOf(
                                "研发团队 <dev@example.test>",
                                "设计协作 <design@example.test>",
                                "林安 <lin@example.test>",
                            )[i % 3],
                        replyTo = "sender@example.test",
                        recipients = account.email,
                        subject = "项目沟通 ${i + 1}",
                        date = System.currentTimeMillis() - i * 86400000L,
                        unread = i < 3,
                        body = "材料已整理完成，请确认时间与后续安排。",
                        attachments =
                            if (i % 4 == 0)
                                listOf(Attachment("1", "沟通材料.pdf", "application/pdf", 20480))
                            else emptyList(),
                    )
                )
            }
        }
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
                vm.dismissStatus()
                vm.go("inbox")
            }
            compose.onNodeWithText("MailAI").assertDoesNotExist()
            compose.onNodeWithTag("inbox-compose").assertIsDisplayed().assertIsEnabled()
            compose
                .onNodeWithTag("inbox-list")
                .performScrollToIndex(
                    if (context.resources.configuration.screenHeightDp < 480) 1 else 2
                )
            device.waitForIdle(1000)
            compose
                .onNode(
                    hasContentDescription("标记星标（此设备）") and
                        hasAnyAncestor(hasTestTag("inbox-mail-INBOX:1:1")),
                    useUnmergedTree = true,
                )
                .performClick()
            compose.waitUntil(5000) { vm.mails.single { it.key == "INBOX:1:1" }.starred }
            compose.onNodeWithTag("inbox-list").performScrollToIndex(0)
            assertEquals("inbox", vm.page)
            val button = compose.onNodeWithTag("inbox-compose").getUnclippedBoundsInRoot()
            assertEquals(
                "Floating compose must stay circular",
                (button.right - button.left).value,
                (button.bottom - button.top).value,
                .5f,
            )
            assertTrue(
                "Floating action remains touchable",
                (button.right - button.left).value >= 48f,
            )
            capture("01-inbox")
            compose.onNodeWithTag("inbox-filter").performClick()
            capture("02-filter")
            compose.onNodeWithTag("filter-unread").performClick()
            assertTrue(vm.unreadOnly)
            compose.onNodeWithText("项目沟通 1").assertExists()
            compose.onNodeWithText("项目沟通 4").assertDoesNotExist()
            compose.onNodeWithTag("inbox-filter").performClick()
            compose.onNodeWithTag("filter-all").performClick()
            compose.onNodeWithTag("mail-search").performClick().performTextInput("项目沟通 14")
            compose.onNodeWithTag("mail-search").assertIsDisplayed()
            capture("03-keyboard")
            compose.onNodeWithTag("inbox-compose").assertDoesNotExist()
            compose.onNodeWithTag("mail-search").performImeAction()
            compose
                .onNode(hasText("项目沟通 14") and hasAnyAncestor(hasTestTag("search-results")))
                .assertIsDisplayed()
            compose.onNodeWithText("取消").performClick()
            assertEquals("", vm.query)
            compose.onNodeWithTag("inbox-list").performScrollToIndex(15)
            val last = compose.onNodeWithTag("inbox-mail-INBOX:1:14").getUnclippedBoundsInRoot()
            val write = compose.onNodeWithTag("inbox-compose").getUnclippedBoundsInRoot()
            assertTrue(
                "The last email must scroll above the floating compose button",
                last.bottom <= write.top,
            )
            capture("04-list-bottom")
            compose.onNodeWithTag("inbox-mail-INBOX:1:14").performClick()
            compose.waitUntil(10000) { vm.page == "reader" && !vm.busy }
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithTag("inbox-mail-INBOX:1:14").assertIsDisplayed()
            val after = compose.onNodeWithTag("inbox-mail-INBOX:1:14").getUnclippedBoundsInRoot()
            assertEquals(last.top.value, after.top.value, 1f)
        } finally {
            scenario.close()
            MailStore(context, account.id).use {
                it.writableDatabase.delete("messages", null, null)
            }
        }
    }
}
