package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.MailAddresses
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PageRedesignTest {
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
    private val mail =
        MailItem(
            "INBOX:1:81",
            "INBOX",
            1,
            81,
            "研发团队 <sender@example.test>",
            "sender@example.test",
            "我 <fixture@example.test>, 林安 <lin@example.test>",
            "项目方案确认",
            System.currentTimeMillis(),
            false,
            "各位同事，您好！\n\n本周的项目方案已整理完成，请确认接口联调与上线排期。\n\n会议时间：周五下午三点\n参与团队：产品、研发与设计\n\n附件包含本次会议材料，请查收。\n\n谢谢！",
            listOf(Attachment("1", "项目方案.pdf", "application/pdf", 4096, "redesign-file")),
            cc = "陈予 <chen@example.test>, 林安 <LIN@example.test>",
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        ReadingPreferences(context).data.edit().clear().commit()
        context.getSystemService(android.content.ClipboardManager::class.java).clearPrimaryClip()
        AccountStore(context).put(account, "synthetic-test-secret")
        File(context.filesDir, "accounts/${account.id}")
            .apply { mkdirs() }
            .resolve("redesign-file")
            .writeText("synthetic attachment")
        MailStore(context, account.id).use { s ->
            s.writableDatabase.delete("contacts", null, null)
            s.writableDatabase.delete("messages", null, null)
            s.writableDatabase.delete("drafts", null, null)
            s.put(mail)
            s.put(mail.copy(key = "Sent:1:83", folder = "Sent", uid = 83, subject = "已发送的项目资料"))
            s.put(
                mail.copy(
                    key = "INBOX:1:82",
                    uid = 82,
                    sender = "方案组 <group@example.test>",
                    subject = "本周排期",
                    body = "请确认排期",
                    attachments = emptyList(),
                )
            )
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
        compose.waitUntil(15000) { vm.ready && !vm.busy }
        scenario.onActivity {
            vm.dismissStatus()
            vm.go("inbox")
        }
        return scenario to vm
    }

    private fun close(scenario: ActivityScenario<MainActivity>) {
        scenario.close()
        ReadingPreferences(context).data.edit().clear().commit()
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
        }
    }

    private fun capture(name: String) {
        compose.mainClock.advanceTimeBy(350)
        compose.waitForIdle()
        device.waitForIdle(500)
        val dir = File(context.getExternalFilesDir(null), "redesign-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun searchScopesAndBackKeepQueryAndMessage() {
        val (scenario, initialVm) = launch()
        var vm = initialVm
        try {
            capture("01-inbox")
            compose.onNodeWithTag("open-search").performClick()
            compose.onNodeWithTag("mail-search").performTextInput("方案")
            compose.onNodeWithTag("mail-search").performImeAction()
            compose.waitUntil(6000) {
                compose.onAllNodesWithText("主题 1").fetchSemanticsNodes().isNotEmpty()
            }
            capture("02-search")
            compose.onNodeWithText("主题 1").performClick()
            compose.onNodeWithText(mail.subject).performClick()
            compose.onNodeWithText("回复全部").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            assertEquals("search", vm.page)
            assertEquals("方案", vm.query)
            compose.onNodeWithContentDescription("返回").performClick()
            assertEquals("inbox", vm.page)
        } finally {
            close(scenario)
        }
    }

    @Test
    fun readerStarReplyAllAndForwardKeepSourceAndAttachments() {
        val (scenario, initialVm) = launch()
        var vm = initialVm
        try {
            compose.onNodeWithText(mail.subject).performClick()
            capture("03-reader")
            compose.onNodeWithContentDescription("添加星标").performClick()
            compose.waitUntil(5000) { mail.key in vm.stars }
            scenario.recreate()
            scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            compose.onNodeWithContentDescription("取消星标").assertExists()
            compose.onNodeWithText("回复全部").performClick()
            assertEquals(
                setOf("sender@example.test", "lin@example.test", "chen@example.test"),
                MailAddresses.parse(vm.draft!!.to).map { it.email.lowercase() }.toSet(),
            )
            assertFalse(vm.draft!!.to.contains(account.email))
            scenario.onActivity { vm.saveAndLeave() }
            compose.waitUntil(10000) { vm.page == "reader" && !vm.busy }
            compose.onNodeWithText("转发").performClick()
            assertTrue(vm.draft!!.body.contains(mail.body!!))
            assertEquals(mail.attachments.single().local, vm.draft!!.attachments.single().local)
            assertEquals(mail.key, vm.selected?.key)
            scenario.onActivity { vm.saveAndLeave() }
            compose.waitUntil(10000) { vm.page == "reader" && !vm.busy }
            scenario.onActivity { vm.go("boxes") }
            compose.onNodeWithText("已发送").assertExists()
            capture("05-folders")
            compose.onNodeWithText("星标邮件").performScrollTo().performClick()
            compose.onNodeWithText(mail.subject).assertExists()
        } finally {
            close(scenario)
        }
    }

    @Test
    fun fullScreenPickerCancelKeepsDraftAndConfirmMergesOnce() {
        val (scenario, initialVm) = launch()
        var vm = initialVm
        try {
            scenario.onActivity { vm.compose() }
            val before = vm.draft!!.to
            compose.onNodeWithText("通讯录").performScrollTo().performClick()
            compose.onNode(hasText("林安") and isToggleable()).performClick()
            compose.onNodeWithText("确定 (1)").assertIsDisplayed()
            capture("04-contact-picker")
            compose.onNodeWithContentDescription("返回").performClick()
            assertEquals(before, vm.draft!!.to)
            compose.onNodeWithText("通讯录").performScrollTo().performClick()
            compose.onNodeWithTag("contact-search").performTextInput("林安")
            compose.onNodeWithTag("contact-search").performImeAction()
            compose.onNode(hasText("林安") and isToggleable()).performClick()
            compose.onNodeWithText("确定 (1)").performClick()
            compose.waitUntil(5000) { vm.draft?.to?.contains("lin@example.test") == true }
            assertEquals(1, MailAddresses.parse(vm.draft!!.to).size)
        } finally {
            close(scenario)
        }
    }

    @Test
    fun settingsPersistSignatureThemeAndFontWithoutChangingExistingDraft() {
        val (scenario, initialVm) = launch()
        var vm = initialVm
        try {
            scenario.onActivity { vm.go("settings") }
            capture("06-settings")
            val imageCache =
                File(context.cacheDir, "mail-images").apply { mkdirs() }.resolve("synthetic-cache")
            imageCache.writeText("temporary image")
            compose.onNodeWithText("清理图片缓存").performScrollTo().performClick()
            compose.onNodeWithText("清理").performClick()
            compose.waitUntil(5000) { !imageCache.exists() }
            assertTrue(File(context.filesDir, "accounts/${account.id}/redesign-file").isFile)
            MailStore(context, account.id).use {
                assertEquals(mail.body, it.messages("INBOX").single { m -> m.key == mail.key }.body)
            }
            compose.onNodeWithText("默认签名").performScrollTo().performClick()
            compose.onNodeWithTag("signature-editor").performTextInput("林安\n产品与研发团队")
            compose.onNodeWithText("保存").performClick()
            compose.onNodeWithText("外观").performScrollTo().performClick()
            compose.onNodeWithText("深色").performClick()
            compose.onNodeWithText("正文字号").performScrollTo().performClick()
            compose.onNodeWithText("20 号").performClick()
            scenario.recreate()
            scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            assertEquals(20, ReadingPreferences(context).bodySize)
            assertEquals("dark", ReadingPreferences(context).theme)
            scenario.onActivity { activity ->
                val controller =
                    androidx.core.view.WindowCompat.getInsetsController(
                        activity.window,
                        activity.window.decorView,
                    )
                assertFalse(
                    "Dark theme must clear the native light-status flag",
                    controller.isAppearanceLightStatusBars,
                )
            }
            // System UI tints animate independently of the Compose test clock.
            // Require the native controls to settle into a readable dark appearance.
            compose.waitUntil(4000) {
                val file =
                    File(context.getExternalFilesDir(null), "redesign-checks/07-settings-dark.png")
                device.takeScreenshot(file)
                val screenshot = android.graphics.BitmapFactory.decodeFile(file.path)
                try {
                    val status = screenshot.getPixel(5, 5)
                    val darkStatus =
                        android.graphics.Color.red(status) < 80 &&
                            android.graphics.Color.green(status) < 80 &&
                            android.graphics.Color.blue(status) < 80
                    val navigation = screenshot.getPixel(5, screenshot.height - 5)
                    val lightNavigation = android.graphics.Color.red(navigation) > 170
                    var contrastPixels = 0
                    val barHeight = (40 * context.resources.displayMetrics.density).toInt()
                    for (y in
                        screenshot.height - barHeight until screenshot.height step 2) for (x in
                        0 until screenshot.width step 2) {
                        val color = screenshot.getPixel(x, y)
                        if (
                            if (lightNavigation)
                                android.graphics.Color.red(color) < 100 &&
                                    android.graphics.Color.green(color) < 100 &&
                                    android.graphics.Color.blue(color) < 100
                            else
                                android.graphics.Color.red(color) > 170 &&
                                    android.graphics.Color.green(color) > 170 &&
                                    android.graphics.Color.blue(color) > 170
                        )
                            contrastPixels++
                    }
                    darkStatus && contrastPixels > 30
                } finally {
                    screenshot.recycle()
                }
            }
            scenario.onActivity {
                vm = ViewModelProvider(it)[MailViewModel::class.java]
                vm.go("inbox")
                vm.compose()
            }
            assertTrue(vm.draft!!.body.contains("产品与研发团队"))
        } finally {
            close(scenario)
        }
    }
}
