package com.mailai.mobile

import android.graphics.Color
import android.graphics.Rect
import android.webkit.WebView
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

@RunWith(AndroidJUnit4::class)
class FeedbackRefinementTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private val context
        get() = instrumentation.targetContext

    private val device
        get() = UiDevice.getInstance(instrumentation)

    private val account =
        Account(
            id = "12d057cd-65b1-437f-abf9-5d29fa101b02",
            email = "feedback@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )
    private val mail =
        MailItem(
            "INBOX:7:1",
            "INBOX",
            7,
            1,
            "体验验收 <team@example.test>",
            "team@example.test",
            account.email,
            "正文深浅外观检查",
            System.currentTimeMillis(),
            false,
            "原邮件正文可选中复制",
            html =
                "<body bgcolor='#ffffff'><p style='color:#000;background:white'>原邮件正文可选中复制</p><table bgcolor='#f5f5f5'><tr><td style='color:rgb(0,0,0);background:#fff'>原始表格</td></tr></table><p style='color:#c00000'>强调内容</p></body>",
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        ReadingPreferences(context).data.edit().clear().commit()
        AccountStore(context).put(account, "synthetic-test-secret")
        MailStore(context, account.id).use { it.put(mail) }
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
        val dir = File(context.getExternalFilesDir(null), "feedback-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun draftExitUsesFullWidthActionsAndCancelPreservesBody() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity {
                ReadingPreferences(context).theme = "dark"
                vm.compose()
                vm.update(vm.draft!!.copy(body = "退出前的正文"))
            }
            compose.onNodeWithTag("compose-back").performClick()
            val save =
                compose.onNodeWithText("保存并返回").assertIsDisplayed().getUnclippedBoundsInRoot()
            val edit = compose.onNodeWithText("继续编辑").assertIsDisplayed().getUnclippedBoundsInRoot()
            val discard =
                compose.onNodeWithText("放弃草稿").assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue(save.bottom <= edit.top && edit.bottom <= discard.top)
            capture("draft-exit-dark")
            compose.onNodeWithText("继续编辑").performClick()
            assertEquals("退出前的正文", vm.draft!!.body)
            compose.onNodeWithTag("compose-back").performClick()
            compose.onNodeWithText("保存并返回").performClick()
            compose.waitUntil(10000) { !vm.busy && vm.page != "compose" }
            assertEquals(
                "退出前的正文",
                MailStore(context, account.id).use { it.draft(vm.draft!!.id)!!.body },
            )
        } finally {
            scenario.close()
            ReadingPreferences(context).data.edit().clear().commit()
        }
    }

    @Test
    fun htmlPaperFollowsAppThemeAndOriginalColorPreferenceRemainsAvailable() {
        val (scenario, vm) = launch()
        fun bounds(): Rect {
            val rect = Rect()
            scenario.onActivity { activity ->
                fun find(view: android.view.View): WebView? {
                    if (view is WebView) return view
                    if (view is android.view.ViewGroup)
                        for (i in 0 until view.childCount) find(view.getChildAt(i))?.let {
                            return it
                        }
                    return null
                }
                requireNotNull(find(activity.window.decorView)).getGlobalVisibleRect(rect)
            }
            return rect
        }
        fun assertPaper(dark: Boolean) {
            compose.waitUntil(10000) {
                runCatching {
                        val r = bounds()
                        val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                        try {
                            val color = image.getPixel(r.centerX(), r.centerY())
                            if (dark) Color.red(color) < 100 else Color.red(color) > 200
                        } finally {
                            image.recycle()
                        }
                    }
                    .getOrDefault(false)
            }
        }
        try {
            scenario.onActivity {
                ReadingPreferences(context).theme = "dark"
                vm.read(mail)
            }
            compose.onNodeWithTag("html-body").assertIsDisplayed()
            assertPaper(true)
            capture("reader-follow-dark")
            scenario.onActivity { vm.go("settings") }
            compose.onNodeWithText("保留邮件原始配色").performScrollTo().performClick()
            scenario.onActivity {
                vm.go("inbox")
                vm.read(mail)
            }
            assertPaper(false)
            capture("reader-original-colors")
            scenario.onActivity {
                ReadingPreferences(context).originalColors = false
                ReadingPreferences(context).theme = "light"
            }
            assertPaper(false)
            capture("reader-follow-light")
        } finally {
            scenario.close()
            ReadingPreferences(context).data.edit().clear().commit()
        }
    }

    @Test
    fun emptyLocalSearchOffersServerSearchAndAnActionableFailure() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("mail-search").performTextInput("更早邮件关键词")
            compose.onNodeWithText("搜索整个收件箱").performClick()
            compose.waitUntil(10000) {
                !vm.busy && vm.matchingServerSearch() && vm.serverSearchFailure.isNotBlank()
            }
            compose.onNodeWithTag("search-page").assertExists()
            compose.onNodeWithText("更早邮件关键词").assertExists()
            compose.onNodeWithText("重试", substring = false).assertExists()
            capture("server-search-retry")
            compose.onNodeWithText("取消").performClick()
            assertEquals("inbox", vm.page)
            assertEquals("", vm.query)
        } finally {
            scenario.close()
            ReadingPreferences(context).data.edit().clear().commit()
        }
    }
}
