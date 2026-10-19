package com.mailai.mobile

import android.view.View
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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

/** Run on both normal and 320dp / 200% font emulator configurations. No real mailbox is used. */
@RunWith(AndroidJUnit4::class)
class InteractionTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val fixture =
        Account(
            id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
            email = "fixture@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        AccountStore(context).put(fixture, "synthetic-test-secret")
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        scenario.onActivity {
            vm.dismissStatus()
            vm.choose(fixture)
        }
        compose.waitUntil(15000) { vm.account?.id == fixture.id && !vm.busy && vm.error }
        return scenario to vm
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(1000)
        val directory =
            File(context.getExternalFilesDir(null), "interaction-checks").apply { mkdirs() }
        device.takeScreenshot(File(directory, "$name.png"))
    }

    @Test
    fun accountAutoDetectsProviderAndNeverReusesItForEnterpriseAddress() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.go("add") }
            capture("account-compact-empty")
            compose.onNodeWithText("QQ 邮箱").assertDoesNotExist()
            compose.onNodeWithContentDescription("IMAP 端口").assertDoesNotExist()
            compose.onNodeWithText("连接邮箱").assertIsNotEnabled()
            compose
                .onNodeWithContentDescription("邮箱地址")
                .performScrollTo()
                .performClick()
                .performTextInput("new@qq.com")
            compose.onNodeWithText("QQ / Foxmail 邮箱").assertExists()
            compose.onNodeWithContentDescription("邮箱地址").performImeAction()
            compose
                .onNodeWithContentDescription("密码或授权码")
                .assertIsFocused()
                .performTextInput("synthetic-only")
            compose.onNodeWithContentDescription("密码或授权码").performImeAction()
            compose.onNodeWithText("连接邮箱").performScrollTo().assertIsEnabled()
            compose
                .onNodeWithContentDescription("邮箱地址")
                .performScrollTo()
                .performTextReplacement("new@company.example")
            compose.onNodeWithContentDescription("邮箱地址").performImeAction()
            compose.onNodeWithContentDescription("密码或授权码").performImeAction()
            compose.onNodeWithText("QQ / Foxmail 邮箱").assertDoesNotExist()
            compose.onNodeWithText("连接邮箱").performScrollTo().assertIsEnabled()
            compose.onNodeWithText("imap.qq.com").assertDoesNotExist()
            compose.onNodeWithText("imap.company.example").performScrollTo().assertExists()
            compose.onNodeWithText("smtp.company.example").performScrollTo().assertExists()
            capture("account-suggested-servers")
            compose.onNodeWithText("修改").performScrollTo().performClick()
            compose
                .onNodeWithContentDescription("收信服务器")
                .performScrollTo()
                .performTextReplacement("imap.custom.example")
            compose
                .onNodeWithContentDescription("发信服务器")
                .performScrollTo()
                .performTextReplacement("smtp.custom.example")
            compose.onNodeWithContentDescription("发信服务器").performImeAction()
            compose.onNodeWithText("连接邮箱").performScrollTo().assertIsEnabled().assertIsDisplayed()
            capture("account-simple-enterprise")
            compose.onNodeWithText("高级设置").performScrollTo().performClick()
            compose.onNodeWithContentDescription("IMAP 端口").performScrollTo().assertExists()
            // These synthetic credentials are never submitted to any real server.
        } finally {
            scenario.close()
        }
    }

    @Test
    fun composerPreviewAndRecipientDetailsPreserveTheDraft() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity {
                vm.compose()
                vm.update(
                    vm.draft!!.copy(
                        to = (1..8).joinToString { "联系人$it <person$it@example.test>" },
                        subject = "周五项目沟通安排",
                        body = "你好，林安：\n\n时间没问题，我会提前看完材料。\n\n周五见。",
                        attachments =
                            listOf(
                                Attachment(
                                    "compose-fixture",
                                    "项目沟通材料.pdf",
                                    "application/pdf",
                                    327680,
                                )
                            ),
                    )
                )
            }
            compose.waitUntil(10000) { vm.saveStatus == "草稿已保存在此设备" }
            compose.onNodeWithText("等 8 人 ›").assertIsDisplayed()
            compose.onNodeWithText("项目沟通材料.pdf").performScrollTo().assertIsDisplayed()
            capture("compose-reference-layout")
            compose.onNodeWithText("等 8 人 ›").performScrollTo().performClick()
            compose.onNodeWithText("收件人 · 8 人").assertIsDisplayed()
            compose.onNodeWithText("完成").performClick()
            assertEquals(8, com.mailai.mobile.mail.MailAddresses.parse(vm.draft!!.to).size)
            assertTrue(vm.draft!!.body.contains("周五见"))
            assertEquals(1, vm.draft!!.attachments.size)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun composerKeepsSendReachableAboveKeyboardAndRetainsLongDraft() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.compose() }
            compose
                .onNodeWithTag("compose-recipient")
                .performScrollTo()
                .performClick()
                .performTextInput("recipient@example.test")
            compose.onNodeWithTag("compose-recipient").performImeAction()
            compose.onNodeWithTag("compose-subject").assertIsFocused().performTextInput("窄屏与键盘测试")
            compose.onNodeWithTag("compose-subject").performImeAction()
            val body = (1..12).joinToString("\n") { "第 $it 行：输入内容和附件必须保留。" }
            compose.onNodeWithTag("compose-body").assertIsFocused().performTextInput(body)
            compose.waitUntil(10000) { vm.draft?.body == body && vm.saveStatus == "草稿已保存在此设备" }
            var keyboardVisible = false
            compose.waitUntil(5000) {
                scenario.onActivity {
                    keyboardVisible =
                        ViewCompat.getRootWindowInsets(it.findViewById<View>(android.R.id.content))
                            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                keyboardVisible
            }
            compose.onNodeWithText("发送").assertIsDisplayed()
            assertEquals(
                body.length,
                compose
                    .onNodeWithTag("compose-body")
                    .fetchSemanticsNode()
                    .config[androidx.compose.ui.semantics.SemanticsProperties.TextSelectionRange]
                    .end,
            )
            capture("composer-keyboard")
            val sendBounds =
                device.findObject(androidx.test.uiautomator.By.text("发送")).visibleBounds
            assertTrue(
                "Send must stay in the physical viewport: $sendBounds",
                sendBounds.top > 0 && !sendBounds.isEmpty,
            )

            var keyboardTop = 0
            scenario.onActivity {
                val decor = it.window.decorView
                keyboardTop =
                    decor.height -
                        requireNotNull(ViewCompat.getRootWindowInsets(decor))
                            .getInsets(WindowInsetsCompat.Type.ime())
                            .bottom
            }
            val editorBottom =
                compose.onNodeWithTag("compose-body").getUnclippedBoundsInRoot().bottom.value *
                    context.resources.displayMetrics.density
            assertTrue(
                "Entire editor must remain above IME: $editorBottom > $keyboardTop",
                editorBottom <= keyboardTop + 1,
            )
            device.pressBack() // IME dismissal must not trigger the leave-composer dialog.
            compose.onNodeWithTag("compose-body").assertExists()
            compose.onNodeWithTag("compose-back").performClick()
            compose.onNodeWithText("继续编辑").assertIsDisplayed().performClick()
            compose.onNodeWithTag("compose-back").performClick()
            compose.onNodeWithText("保存并返回").assertIsDisplayed().performClick()
            compose.waitUntil(10000) { !vm.busy && vm.page == "inbox" }
            MailStore(context, fixture.id).use { store ->
                assertEquals(body, store.draft(requireNotNull(vm.draft).id)?.body)
            }
        } finally {
            scenario.close()
        }
    }

    @Test
    fun failedSyncCanRetryAndCancellationKeepsCacheAndDraft() {
        val draft = Draft(subject = "取消与重试不能丢失的草稿", body = "离线编辑内容")
        MailStore(context, fixture.id).use { it.save(draft) }
        val (scenario, vm) = launch()
        try {
            assertTrue(vm.error)
            compose.onNodeWithText("重试").assertIsDisplayed().performClick()
            compose.waitUntil(10000) { !vm.busy && vm.error }
            capture("retry-error")
            scenario.onActivity {
                vm.refresh()
                assertTrue(vm.busy)
                assertFalse(vm.error)
                vm.cancel()
                assertFalse(vm.cancellable)
                assertEquals("正在取消，请稍候…", vm.status)
            }
            compose.waitUntil(10000) { !vm.busy }
            assertFalse(vm.error)
            assertEquals("已取消，原有内容已保留", vm.status)
            compose.onNodeWithText("重试").assertIsDisplayed()
            MailStore(context, fixture.id).use {
                assertEquals(draft.body, it.draft(draft.id)?.body)
            }
            capture("cancelled")
        } finally {
            scenario.close()
        }
    }
}
