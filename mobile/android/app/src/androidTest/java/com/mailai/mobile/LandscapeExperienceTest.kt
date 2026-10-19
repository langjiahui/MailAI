package com.mailai.mobile

import android.content.pm.ActivityInfo
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

@RunWith(AndroidJUnit4::class)
@OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
class LandscapeExperienceTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun landscapePagesAndKeyboardKeepContentAndActionsReachable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val account =
            Account(
                id = "12d057cd-65b1-437f-abf9-5d29fa101a01",
                email = "landscape@example.test",
                imap = Server("127.0.0.1", 993),
                smtp = Server("127.0.0.1", 465),
            )
        AccountStore(context).put(account, "synthetic-test-secret")
        val mail =
            MailItem(
                "INBOX:9:1",
                "INBOX",
                9,
                1,
                "横屏验收 <team@example.test>",
                "team@example.test",
                account.email,
                "横屏邮件阅读",
                System.currentTimeMillis(),
                false,
                "邮件正文与所有操作都应保持可达。",
            )
        MailStore(context, account.id).use { it.put(mail) }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        try {
            scenario.onActivity {
                vm = ViewModelProvider(it)[MailViewModel::class.java]
                it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            compose.waitUntil(15000) {
                vm.ready &&
                    !vm.busy &&
                    context.resources.configuration.screenWidthDp >
                        context.resources.configuration.screenHeightDp
            }
            if (vm.account?.id != account.id) {
                scenario.onActivity { vm.choose(account) }
                compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy }
            }
            val dir = File(context.getExternalFilesDir(null), "landscape-checks").apply { mkdirs() }
            fun capture(name: String) {
                compose.mainClock.advanceTimeBy(400)
                compose.waitForIdle()
                device.waitForIdle(1000)
                val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                assertTrue(
                    "The captured window must actually be landscape",
                    bitmap.width > bitmap.height,
                )
                bitmap.recycle()
                assertTrue(device.takeScreenshot(File(dir, "$name.png")))
            }
            for (page in listOf("inbox", "boxes", "contacts", "settings")) {
                scenario.onActivity {
                    vm.dismissStatus()
                    vm.go(page)
                }
                capture(page)
            }
            scenario.onActivity {
                vm.go("inbox")
                vm.read(mail)
            }
            compose.waitUntil(10000) { !vm.busy && vm.page == "reader" }
            capture("reader")
            scenario.onActivity {
                vm.go("inbox")
                vm.compose()
            }
            compose
                .onNodeWithTag("compose-body")
                .performScrollTo()
                .performClick()
                .performTextInput("横屏正文与格式不丢失")
            device.waitForIdle(1000)
            compose.onNodeWithTag("compose-title").assertDoesNotExist()
            compose.onNodeWithTag("compose-body").performTextInputSelection(TextRange(0, 2))
            compose.onNodeWithContentDescription("加粗").performScrollTo()
            device.waitForIdle(1000)
            compose.onNodeWithContentDescription("加粗").performClick()
            compose.waitUntil(5000) {
                vm.draft!!.styles.any {
                    it.kind == BodyStyleKind.BOLD && it.start == 0 && it.end == 2
                }
            }
            val tools = compose.onNodeWithTag("compose-formatting").getUnclippedBoundsInRoot()
            val send =
                compose.onNodeWithTag("compose-send").assertIsDisplayed().getUnclippedBoundsInRoot()
            val root = compose.onRoot().getUnclippedBoundsInRoot()
            assertTrue(
                "Formatting toolbar must not be clipped",
                tools.top >= root.top && tools.right <= send.left,
            )
            assertTrue(send.right <= root.right && send.bottom <= root.bottom)
            compose.onNodeWithTag("compose-photo").assertIsDisplayed()
            compose.onNodeWithTag("compose-attachment").assertIsDisplayed()
            capture("compose-keyboard")
            device.pressBack()
            device.waitForIdle(1000)
            compose.onNodeWithTag("compose-back").performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { !vm.busy && vm.page != "compose" }
            val saved = MailStore(context, account.id).use { it.draft(vm.draft!!.id)!! }
            assertEquals("横屏正文与格式不丢失", saved.body)
            assertTrue(saved.styles.any { it.kind == BodyStyleKind.BOLD })
        } finally {
            scenario.close()
        }
    }
}
