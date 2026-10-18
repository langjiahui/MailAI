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
    fun accountChoicesWrapAndFormRemainsReachableWithKeyboard() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.go("add") }
            for (label in listOf("QQ 邮箱", "163 邮箱", "其他邮箱")) {
                val node = compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
                val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
                node.performSemanticsAction(
                    androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult
                ) {
                    it(layouts)
                }
                assertTrue(
                    "$label must not overflow: ${layouts.map { "${it.size}, w=${it.multiParagraph.width}, line=${it.getLineRight(0)}, h=${it.didOverflowHeight}" }}",
                    layouts.isNotEmpty() &&
                        layouts.none {
                            it.didOverflowHeight ||
                                (0 until it.lineCount).any { line ->
                                    it.getLineRight(line) > it.size.width + 1f ||
                                        it.isLineEllipsized(line)
                                }
                        },
                )
            }
            compose.onNodeWithText("QQ 邮箱").performScrollTo().performClick()
            compose
                .onNodeWithText("邮箱地址")
                .performScrollTo()
                .performClick()
                .performTextInput("new@example.test")
            compose.onNodeWithText("邮箱地址").performImeAction()
            compose.onNodeWithText("授权码 / 密码").assertIsFocused().performTextInput("synthetic-only")
            capture("account-keyboard")
            compose.onNodeWithText("授权码 / 密码").performImeAction()
            compose.onNodeWithText("验证并添加").performScrollTo().assertIsDisplayed()
            // Do not connect to a real service with these synthetic credentials.
            capture("account-actions")
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
                .onNodeWithText("收件人")
                .performScrollTo()
                .performClick()
                .performTextInput("recipient@example.test")
            compose.onNodeWithText("收件人").performImeAction()
            compose.onNodeWithText("主题").assertIsFocused().performTextInput("窄屏与键盘测试")
            compose.onNodeWithText("主题").performImeAction()
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
            compose.onNodeWithText("‹  返回").performClick()
            compose.onNodeWithText("继续编辑").assertIsDisplayed().performClick()
            compose.onNodeWithText("‹  返回").performClick()
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
