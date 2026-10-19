package com.mailai.mobile

import android.graphics.Color
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

/** Integrates the previously separate inbox, editor and reading-page changes. */
@RunWith(AndroidJUnit4::class)
class UnifiedExperienceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private val context
        get() = instrumentation.targetContext

    private val device
        get() = UiDevice.getInstance(instrumentation)

    private val account =
        Account(
            id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
            email = "fixture@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )
    private val mail =
        MailItem(
            "INBOX:31:91",
            "INBOX",
            31,
            91,
            "联调组 <team@example.test>",
            "team@example.test",
            "陈予 <chen@example.test>, fixture@example.test",
            "整体体验验收",
            System.currentTimeMillis(),
            false,
            "周五确认接口与排期。",
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        ReadingPreferences(context).data.edit().clear().commit()
        AccountStore(context).put(account, "synthetic-test-secret")
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
            it.writableDatabase.delete("contacts", null, null)
            it.put(mail)
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

    private fun capture(name: String, dark: Boolean) {
        compose.mainClock.advanceTimeBy(400)
        compose.waitForIdle()
        device.waitForIdle(500)
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val pixel = bitmap.getPixel(3, bitmap.height / 3)
        val brightness = (Color.red(pixel) + Color.green(pixel) + Color.blue(pixel)) / 3
        assertTrue(
            "Page $name must follow the app theme, brightness=$brightness",
            if (dark) brightness < 100 else brightness > 190,
        )
        // Check real system navigation pixels on every page, not only the settings page.
        val navigation = bitmap.getPixel(3, bitmap.height - 3)
        val lightNavigation = Color.red(navigation) > 170
        var contrasting = 0
        val barHeight = (40 * context.resources.displayMetrics.density).toInt()
        for (y in bitmap.height - barHeight until bitmap.height step 2) {
            for (x in 0 until bitmap.width step 2) {
                val color = bitmap.getPixel(x, y)
                if (
                    if (lightNavigation)
                        Color.red(color) < 100 &&
                            Color.green(color) < 100 &&
                            Color.blue(color) < 100
                    else
                        Color.red(color) > 170 &&
                            Color.green(color) > 170 &&
                            Color.blue(color) > 170
                )
                    contrasting++
            }
        }
        assertTrue("System navigation remains readable on $name", contrasting > 30)
        bitmap.recycle()
        val dir = File(context.getExternalFilesDir(null), "unified-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun everyPageUsesSelectedThemeAndEditorActionsStayWithinViewport() {
        val (scenario, vm) = launch()
        try {
            for (theme in listOf("dark", "light")) {
                scenario.onActivity { ReadingPreferences(context).theme = theme }
                for (page in listOf("inbox", "boxes", "drafts", "contacts", "settings")) {
                    scenario.onActivity { vm.go(page) }
                    capture("$theme-$page", theme == "dark")
                }
                scenario.onActivity {
                    vm.go("inbox")
                    vm.compose()
                }
                val send =
                    compose
                        .onNodeWithTag("compose-send")
                        .assertIsDisplayed()
                        .getUnclippedBoundsInRoot()
                val title = compose.onNodeWithTag("compose-title").getUnclippedBoundsInRoot()
                val root = compose.onRoot().getUnclippedBoundsInRoot()
                assertTrue(title.right <= send.left && send.right <= root.right)
                assertTrue(
                    send.right - send.left >= send.bottom - send.top &&
                        (send.bottom - send.top).value >= 47.5f
                )
                val photo = compose.onNodeWithTag("compose-photo").getUnclippedBoundsInRoot()
                val file = compose.onNodeWithTag("compose-attachment").getUnclippedBoundsInRoot()
                assertTrue(
                    photo.right <= file.left &&
                        photo.bottom <= root.bottom &&
                        file.bottom <= root.bottom
                )
                capture("$theme-compose", theme == "dark")
                scenario.onActivity { vm.saveAndLeave() }
                compose.waitUntil(10000) { !vm.busy && vm.page != "compose" }
            }
        } finally {
            scenario.close()
            ReadingPreferences(context).data.edit().clear().commit()
        }
    }

    @Test
    fun contactSelectionTargetsCopiesAndStarIsConsistentAcrossPages() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithText(mail.subject).performClick()
            compose.onNodeWithContentDescription("添加星标").performClick()
            compose.waitUntil(5000) { mail.key in vm.stars }
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithTag("inbox-filter").performClick()
            compose.onNodeWithTag("filter-starred").performClick()
            compose.onNodeWithText(mail.subject).performClick()
            compose.onNodeWithContentDescription("取消星标").performClick()
            compose.waitUntil(5000) { mail.key !in vm.stars }
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("暂无星标邮件").assertExists()
            compose.onNodeWithText("查看全部邮件").performClick()
            compose.onNodeWithTag("inbox-compose").performClick()
            compose
                .onNodeWithTag("compose-recipient")
                .performClick()
                .performTextInput("to@example.test")
            assertEquals("to@example.test", vm.draft!!.to)
            device.pressBack()
            compose.onNodeWithText("抄送 / 密送").performScrollTo().performClick()
            compose.onNodeWithContentDescription("抄送 通讯录").performScrollTo().performClick()
            compose.onNode(hasText("联调组") and isToggleable()).performClick()
            compose.onNodeWithText("确定 (1)").performClick()
            assertEquals(
                "team@example.test",
                com.mailai.mobile.mail.MailAddresses.parse(vm.draft!!.cc).single().email,
            )
            assertEquals("to@example.test", vm.draft!!.to)
            assertEquals("", vm.draft!!.bcc)
            compose.onNodeWithContentDescription("密送 通讯录").performScrollTo().performClick()
            compose.onNode(hasText("陈予") and isToggleable()).performClick()
            compose.onNodeWithText("确定 (1)").performClick()
            assertEquals(
                "chen@example.test",
                com.mailai.mobile.mail.MailAddresses.parse(vm.draft!!.bcc).single().email,
            )
            val id = vm.draft!!.id
            scenario.onActivity { vm.saveAndLeave() }
            compose.waitUntil(10000) { !vm.busy && vm.page != "compose" }
            val saved = MailStore(context, account.id).use { it.draft(id)!! }
            assertTrue(
                saved.cc.contains("team@example.test") && saved.bcc.contains("chen@example.test")
            )
        } finally {
            scenario.close()
        }
    }
}
