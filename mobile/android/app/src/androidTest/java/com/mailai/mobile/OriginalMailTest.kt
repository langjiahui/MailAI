package com.mailai.mobile

import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.*
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import javax.mail.internet.MimeUtility
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OriginalMailTest {
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

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        context.getSystemService(android.content.ClipboardManager::class.java).clearPrimaryClip()
        assertTrue(device.wait(Until.gone(By.res("com.android.systemui", "clipboard_ui")), 10000))
        assertEquals("MailAI", context.applicationInfo.loadLabel(context.packageManager).toString())
        AccountStore(context).put(account, "synthetic-test-secret")
        val dir = File(context.filesDir, "accounts/${account.id}").apply { mkdirs() }
        File(dir, "document-fixture").writeText("%PDF-synthetic-fixture")
        val image = File(dir, "inline-fixture")
        Bitmap.createBitmap(120, 40, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.rgb(51, 74, 59))
            image.outputStream().use { compress(Bitmap.CompressFormat.PNG, 100, it) }
            recycle()
        }
        val people =
            "我 <${account.email}>," +
                (1..35).joinToString(",") {
                    "\"${MimeUtility.encodeText("联系人$it","UTF-8","B")}\" <person$it@example.test>"
                }
        val html =
            """<!doctype html><html><head><style>body{font-family:Arial;color:#253027;background:white;user-select:none;-webkit-user-select:none}h2{font-size:22px;color:#334a3b}table{width:100%;border-collapse:collapse}td,th{border:1px solid #bdcbbb;padding:10px}th{background:#e7efe2;text-align:left}</style></head><body>
            <h2>项目状态 · 原始排版</h2><p>请确认以下信息，<b style="color:#a54a22">周五前反馈</b>。</p><table><tr><th>事项</th><th>状态</th></tr><tr><td>接口联调</td><td>已完成</td></tr><tr><td>上线计划</td><td>待确认</td></tr></table><p>内嵌图片：</p><img alt="项目标识" src="cid:brand" width="240" height="80"><p><a href="https://example.test/details">查看详情</a></p><script>document.body.innerText='SCRIPT_EXECUTED'</script></body></html>"""
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
            it.put(
                MailItem(
                    "INBOX:1:71",
                    "INBOX",
                    1,
                    71,
                    "\"${MimeUtility.encodeText("研发通知","UTF-8","B")}\" <notice@example.test>",
                    "notice@example.test",
                    people,
                    "多人收件人与原版邮件",
                    System.currentTimeMillis(),
                    false,
                    "项目状态 · 原始排版\n接口联调：已完成\n上线计划：待确认",
                    listOf(
                        Attachment(
                            "1",
                            "标识.png",
                            "image/png",
                            image.length(),
                            "inline-fixture",
                            "brand",
                        ),
                        Attachment(
                            "2",
                            "说明.pdf",
                            "application/pdf",
                            22,
                            "document-fixture",
                            "document",
                        ),
                    ),
                    html = html,
                )
            )
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
        val dir = File(context.getExternalFilesDir(null), "original-mail-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    private fun cleanup(scenario: ActivityScenario<MainActivity>) {
        scenario.close()
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
        }
    }

    private fun web(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup)
            for (i in 0 until view.childCount) web(view.getChildAt(i))?.let {
                return it
            }
        return null
    }

    @Test
    fun encodedRecipientsCollapseAndOriginalHtmlRendersWithoutScripts() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithText("多人收件人与原版邮件").performClick()
            compose.onNodeWithText("研发通知").assertExists()
            compose.onNodeWithText("发给我 · 共 36 人  ›").assertExists()
            compose.onNodeWithText("回复").assertIsDisplayed()
            compose.waitUntil(10000) {
                compose.onAllNodesWithTag("html-body").fetchSemanticsNodes().isNotEmpty() &&
                    runCatching { compose.onNodeWithTag("html-body").assertIsDisplayed() }.isSuccess
            }
            compose.onNodeWithTag("html-body").assertIsDisplayed()
            compose.waitUntil(10000) {
                var ready = false
                scenario.onActivity { activity ->
                    ready =
                        web(activity.window.decorView)?.let {
                            it.contentHeight > 0 && it.progress == 100
                        } == true
                }
                ready
            }
            scenario.onActivity { web(it.window.decorView)?.scrollTo(0, 0) }
            scenario.onActivity { vm.dismissStatus() }
            capture("rendering-check")
            // WebView's virtual accessibility tree can arrive after its first painted frame.
            // Verify the actual original heading pixels, not a cached UiAutomator node.
            val bounds = android.graphics.Rect()
            scenario.onActivity { activity ->
                val renderer = requireNotNull(web(activity.window.decorView))
                val location = IntArray(2)
                renderer.getLocationOnScreen(location)
                bounds.set(
                    location[0],
                    location[1],
                    location[0] + renderer.width,
                    location[1] +
                        minOf(
                            renderer.height,
                            (120 * context.resources.displayMetrics.density).toInt(),
                        ),
                )
            }
            val rendered =
                android.graphics.BitmapFactory.decodeFile(
                    File(
                            context.getExternalFilesDir(null),
                            "original-mail-checks/rendering-check.png",
                        )
                        .path
                )
            try {
                var headingPixels = 0
                for (y in
                    bounds.top.coerceAtLeast(0) until
                        bounds.bottom.coerceAtMost(rendered.height)) for (x in
                    bounds.left.coerceAtLeast(0) until
                        bounds.right.coerceAtMost(rendered.width)) if (
                    rendered.getPixel(x, y) and 0xffffff == 0x334a3b
                )
                    headingPixels++
                assertTrue(
                    "Original green heading must be painted inside the mail renderer",
                    headingPixels > 100,
                )
            } finally {
                rendered.recycle()
            }
            assertFalse(device.hasObject(By.textContains("SCRIPT_EXECUTED")))
            scenario.onActivity {
                val renderer = requireNotNull(web(it.window.decorView))
                assertFalse(renderer.settings.javaScriptEnabled)
                assertFalse(renderer.settings.allowFileAccess)
                assertFalse(renderer.settings.allowContentAccess)
            }
            capture("reader-original-collapsed")
            compose.onNodeWithText("附件 1").assertIsDisplayed().performClick()
            compose
                .onNode(hasText("说明.pdf") and hasAnyAncestor(hasTestTag("attachment-sheet")))
                .assertExists()
            compose.onNodeWithText("完成").performClick()
            compose.onNodeWithContentDescription("详情").performClick()
            compose.onNodeWithTag("mail-details-sheet").assertIsDisplayed()
            compose.onNodeWithTag("mail-details-list").performScrollToNode(hasText("收件人"))
            compose.onNodeWithTag("mail-details-list").performScrollToNode(hasText("联系人1"))
            compose.onNodeWithText("联系人1").assertExists()
            compose.onNodeWithText("person1@example.test").assertExists()
            capture("people-decoded-details")
            compose.onNodeWithText("存入通讯录").assertDoesNotExist()
            compose.onNodeWithText("联系人1").performClick()
            capture("person-actions")
            compose.onNodeWithText("复制邮箱").performScrollTo().performClick()
            compose.onNodeWithText("已复制邮箱").assertExists()
            compose.onNodeWithText("已在通讯录").assertExists()
            assertEquals(
                "person1@example.test",
                context
                    .getSystemService(android.content.ClipboardManager::class.java)
                    .primaryClip!!
                    .getItemAt(0)
                    .text
                    .toString(),
            )
            compose.onNodeWithText("联系人1").performClick()
            compose.onNodeWithText("联系人1").assertIsDisplayed()
            compose.onNodeWithText("完成").performClick()
            compose.onNodeWithText("文本").assertDoesNotExist()
            compose.onNodeWithText("原版").assertDoesNotExist()
            compose.onNodeWithTag("html-body").assertIsDisplayed()
            assertNotNull(vm.selected?.html)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun originalBodyLongPressCopiesActualText() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithText("多人收件人与原版邮件").performClick()
            compose.onNodeWithText("文本").assertDoesNotExist()
            context
                .getSystemService(android.content.ClipboardManager::class.java)
                .clearPrimaryClip()
            compose.waitUntil(10000) {
                compose.onAllNodesWithTag("html-body").fetchSemanticsNodes().isNotEmpty()
            }
            var target: androidx.test.uiautomator.UiObject2? = null
            for (attempt in 0..6) {
                target = device.wait(Until.findObject(By.textContains("周五前反馈")), 1000)
                if ((target?.visibleBounds?.height() ?: 0) > 12) break
                scenario.onActivity {
                    web(it.window.decorView)
                        ?.scrollBy(0, (120 * context.resources.displayMetrics.density).toInt())
                }
                device.waitForIdle(500)
            }
            requireNotNull(target).longClick()
            capture("body-selection-menu")
            val copy =
                requireNotNull(
                    device.wait(
                        Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)copy|复制"))),
                        5000,
                    )
                )
            copy.click()
            var copied = ""
            compose.waitUntil(5000) {
                copied =
                    context
                        .getSystemService(android.content.ClipboardManager::class.java)
                        .primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)
                        ?.text
                        ?.toString()
                        ?.trim()
                        .orEmpty()
                copied.isNotBlank()
            }
            assertTrue(
                "Long press must copy the selected mail body",
                copied.isNotBlank() && "请确认以下信息，周五前反馈。".contains(copied),
            )
            assertEquals("reader", vm.page)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun mailLinkOpensNormallyAndCancellingKeepsTheOriginalMessage() {
        val (scenario, vm) = launch()
        try {
            context
                .getSystemService(android.content.ClipboardManager::class.java)
                .clearPrimaryClip()
            assertTrue(
                device.wait(Until.gone(By.res("com.android.systemui", "clipboard_ui")), 10000)
            )
            compose.onNodeWithText("多人收件人与原版邮件").performClick()
            compose.waitUntil(10000) {
                var ready = false
                scenario.onActivity { activity ->
                    ready =
                        web(activity.window.decorView)?.let {
                            it.contentHeight > 0 && it.progress == 100
                        } == true
                }
                ready
            }
            val bounds = android.graphics.Rect()
            scenario.onActivity { activity ->
                val renderer = requireNotNull(web(activity.window.decorView))
                renderer.pageDown(true)
                val xy = IntArray(2)
                renderer.getLocationOnScreen(xy)
                bounds.set(xy[0], xy[1], xy[0] + renderer.width, xy[1] + renderer.height)
            }
            var target: androidx.test.uiautomator.UiObject2? = null
            for (attempt in 0..5) {
                device.waitForIdle(500)
                target =
                    device.findObject(By.text("查看详情")) ?: device.findObject(By.descContains("查看详情"))
                if ((target?.visibleBounds?.height() ?: 0) > 8) break
                device.swipe(
                    bounds.centerX(),
                    bounds.top + bounds.height() * 3 / 4,
                    bounds.centerX(),
                    bounds.top + bounds.height() / 4,
                    24,
                )
            }
            if (target != null) target.click()
            else {
                // WebView may paint a link before exposing its virtual accessibility node.
                // Tap the real blue link pixels inside the renderer, then require the real dialog.
                capture("link-painted")
                // Header/attachment measurement can finish after the WebView reports loaded.
                // Use the renderer's current clipped rectangle, not its first layout bounds.
                scenario.onActivity { activity ->
                    requireNotNull(web(activity.window.decorView)).getGlobalVisibleRect(bounds)
                }
                val bitmap =
                    android.graphics.BitmapFactory.decodeFile(
                        File(
                                context.getExternalFilesDir(null),
                                "original-mail-checks/link-painted.png",
                            )
                            .path
                    )
                try {
                    var left = bitmap.width
                    var top = bitmap.height
                    var right = 0
                    var bottom = 0
                    for (y in
                        bounds.top.coerceAtLeast(0) until
                            bounds.bottom.coerceAtMost(bitmap.height)) for (x in
                        bounds.left.coerceAtLeast(0) until
                            bounds.right.coerceAtMost(bitmap.width)) {
                        val pixel = bitmap.getPixel(x, y)
                        if (
                            android.graphics.Color.blue(pixel) > 150 &&
                                android.graphics.Color.red(pixel) < 80 &&
                                android.graphics.Color.green(pixel) < 80
                        ) {
                            left = minOf(left, x)
                            right = maxOf(right, x)
                            top = minOf(top, y)
                            bottom = maxOf(bottom, y)
                        }
                    }
                    assertTrue(
                        "The original HTML link must be visible",
                        right > left && bottom > top,
                    )
                    assertTrue(device.click((left + right) / 2, (top + bottom) / 2))
                } finally {
                    bitmap.recycle()
                }
            }
            compose.waitUntil(5000) {
                runCatching { compose.onNodeWithText("打开链接？").assertIsDisplayed() }.isSuccess
            }
            capture("body-link-action")
            compose.onNodeWithText("https://example.test/details").assertExists()
            compose.onNodeWithText("取消").performClick()
            compose.onNodeWithTag("html-body").assertIsDisplayed()
            assertEquals("reader", vm.page)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun plainBodyLongPressCopiesWithoutShowingAModeSwitch() {
        val (scenario, vm) = launch()
        val body = "MailAI plain text selection"
        try {
            val cached = vm.mails.single { it.key == "INBOX:1:71" }
            scenario.onActivity { vm.read(cached.copy(html = null, body = body)) }
            compose.onNodeWithText("文本").assertDoesNotExist()
            compose.onNodeWithTag("html-body").assertDoesNotExist()
            context
                .getSystemService(android.content.ClipboardManager::class.java)
                .clearPrimaryClip()
            compose.onNodeWithText(body).performTouchInput { longClick(center) }
            val copy =
                requireNotNull(
                    device.wait(
                        Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)copy|复制"))),
                        5000,
                    )
                )
            copy.click()
            var copied = ""
            compose.waitUntil(5000) {
                copied =
                    context
                        .getSystemService(android.content.ClipboardManager::class.java)
                        .primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)
                        ?.text
                        ?.toString()
                        ?.trim()
                        .orEmpty()
                copied.isNotBlank() && body.contains(copied)
            }
            assertTrue(body.contains(copied))
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun detailsSheetKeepsLongSubjectCcAndLastRecipientReachableAndDismissesBackToMail() {
        val (scenario, vm) = launch()
        val subject = "关于跨团队项目推进、接口联调与上线准备事项的完整说明，请保留所有工作信息并在会议前确认安排"
        val cc = "抄送同事 <very.long.department.address.for.copy@example.test>"
        try {
            val cached = vm.mails.single { it.key == "INBOX:1:71" }
            scenario.onActivity { vm.read(cached.copy(subject = subject, cc = cc)) }
            compose.onNodeWithContentDescription("详情").performClick()
            compose.onNodeWithTag("mail-details-sheet").assertIsDisplayed()
            compose
                .onNode(hasText(subject) and hasAnyAncestor(hasTestTag("mail-details-sheet")))
                .assertExists()
            compose.onNodeWithTag("mail-details-list").performScrollToNode(hasText("联系人35"))
            compose.onNodeWithText("person35@example.test").assertIsDisplayed()
            compose.onNodeWithTag("mail-details-list").performScrollToNode(hasText("抄送同事"))
            compose
                .onNodeWithText("very.long.department.address.for.copy@example.test")
                .assertIsDisplayed()
            capture("details-long-address-cc")
            compose.onNodeWithTag("mail-details-list").performScrollToIndex(0)
            capture("details-long-subject")
            val handle = compose.onNodeWithTag("mail-sheet-handle", useUnmergedTree = true)
            val expandedTop = handle.getUnclippedBoundsInRoot().top
            // Long panels now expose a compact anchor: Back first collapses it, then
            // dismisses it. Explicit "完成" still dismisses in one action.
            device.pressBack()
            compose.waitForIdle()
            compose.onNodeWithTag("mail-details-sheet").assertExists()
            assertTrue(handle.getUnclippedBoundsInRoot().top > expandedTop)
            device.pressBack()
            compose.waitUntil(5000) {
                compose.onAllNodesWithTag("mail-details-sheet").fetchSemanticsNodes().isEmpty()
            }
            compose.onNodeWithText("回复").assertIsDisplayed()
            assertEquals("reader", vm.page)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun contactPickerAddsDecodedRecipientAndKeepsItFolded() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.go("contacts") }
            compose.onNodeWithText("通讯录").assertExists()
            capture("address-book")
            scenario.onActivity {
                vm.go("inbox")
                vm.compose()
            }
            compose.onNodeWithContentDescription("通讯录").performScrollTo().performClick()
            compose.onNodeWithTag("contact-search").performTextInput("person1@example.test")
            compose.onNodeWithText("联系人1").performClick()
            compose.onNodeWithText("确定 (1)").performClick()
            compose.waitUntil(10000) { vm.draft?.to?.contains("person1@example.test") == true }
            compose.onNodeWithText("联系人1").assertExists()
            compose.onNodeWithText("1 人 ›").assertExists()
            capture("composer-selected-contact")
            assertFalse(vm.draft!!.to.contains("=?"))
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun newContactPersistsAndCanBeSelectedAfterRecreation() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.go("contacts") }
            compose.onNodeWithText("新建联系人").performClick()
            compose.onNodeWithText("姓名（选填）").performTextInput("测试同事")
            compose.onNodeWithText("邮箱地址").performTextInput("colleague@example.test")
            compose.onNodeWithText("保存联系人").performClick()
            compose.waitUntil(10000) {
                !vm.busy &&
                    vm.contacts.any { it.email == "colleague@example.test" && it.name == "测试同事" }
            }
            scenario.recreate()
            compose.onNodeWithText("搜索联系人").performTextInput("colleague@example.test")
            compose.onNodeWithTag("contacts-list").performScrollToNode(hasText("测试同事"))
            capture("new-contact-before-write")
            compose.onNodeWithText("测试同事").assertIsDisplayed().performClick()
            capture("new-contact-after-write")
            compose.waitUntil(10000) { vm.draft?.to?.contains("colleague@example.test") == true }
            assertEquals("测试同事", MailAddresses.parse(vm.draft!!.to).single().name)
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun floatingBubbleDoesNotMoveContentAndDisappears() {
        val (scenario, vm) = launch()
        try {
            val before = compose.onNodeWithTag("inbox-list").getUnclippedBoundsInRoot()
            scenario.onActivity { vm.showMessage("联系人已保存") }
            compose.onNodeWithTag("operation-bubble").assertIsDisplayed()
            val after = compose.onNodeWithTag("inbox-list").getUnclippedBoundsInRoot()
            assertEquals(before.top.value, after.top.value, 0.1f)
            assertEquals(before.bottom.value, after.bottom.value, 0.1f)
            capture("floating-bubble-no-layout-shift")
            compose.mainClock.advanceTimeBy(5000)
            compose.onNodeWithTag("operation-bubble").assertDoesNotExist()
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun rendererFailureKeepsTextAndCanRetryOriginal() {
        val (scenario, _) = launch()
        try {
            compose.onNodeWithText("多人收件人与原版邮件").performClick()
            compose.waitUntil(10000) {
                var ready = false
                scenario.onActivity { activity ->
                    ready =
                        web(activity.window.decorView)?.let {
                            it.contentHeight > 0 && it.progress == 100
                        } == true
                }
                ready
            }
            scenario.onActivity {
                requireNotNull(web(it.window.decorView)).loadUrl(MailHtml.ORIGIN + "unavailable")
            }
            compose.waitUntil(10000) {
                compose.onAllNodesWithText("原版暂时无法显示，已保留文本正文").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("项目状态 · 原始排版\n接口联调：已完成\n上线计划：待确认").assertExists()
            compose.onNodeWithText("重新显示原邮件").performScrollTo().performClick()
            compose.waitUntil(10000) {
                var ready = false
                scenario.onActivity { activity ->
                    ready =
                        web(activity.window.decorView)?.let {
                            it.contentHeight > 0 && it.progress == 100
                        } == true
                }
                ready
            }
            compose.onNodeWithTag("html-body").assertIsDisplayed()
        } finally {
            cleanup(scenario)
        }
    }

    @Test
    fun inlineImageAndHtmlRemainAvailableOffline() {
        val (scenario, vm) = launch()
        try {
            device.executeShellCommand("svc wifi disable")
            device.executeShellCommand("svc data disable")
            compose.waitUntil(10000) { !vm.online }
            compose.onNodeWithText("多人收件人与原版邮件").performClick()
            compose.waitUntil(10000) {
                compose.onAllNodesWithTag("html-body").fetchSemanticsNodes().isNotEmpty() &&
                    runCatching { compose.onNodeWithTag("html-body").assertIsDisplayed() }.isSuccess
            }
            compose.onNodeWithTag("html-body").assertIsDisplayed()
            compose.waitUntil(10000) {
                var ready = false
                scenario.onActivity { activity ->
                    ready =
                        web(activity.window.decorView)?.let {
                            it.contentHeight > 0 && it.progress == 100
                        } == true
                }
                ready
            }
            scenario.onActivity { web(it.window.decorView)?.scrollTo(0, 0) }
            scenario.onActivity { vm.dismissStatus() }
            capture("rendering-check")
            compose.waitUntil(8000) {
                var rendered = false
                scenario.onActivity { activity ->
                    web(activity.window.decorView)?.let {
                        rendered = it.contentHeight > 300 && it.progress == 100
                    }
                }
                rendered
            }
            compose.waitUntil(6000) {
                compose.onAllNodesWithTag("operation-bubble").fetchSemanticsNodes().isEmpty()
            }
            scenario.onActivity { web(it.window.decorView)?.pageDown(true) }
            val bounds = compose.onNodeWithTag("html-body").getUnclippedBoundsInRoot()
            val density = context.resources.displayMetrics.density
            var green = 0
            for (attempt in 0..6) {
                capture("offline-image-pixels")
                val bitmap =
                    android.graphics.BitmapFactory.decodeFile(
                        File(
                                context.getExternalFilesDir(null),
                                "original-mail-checks/offline-image-pixels.png",
                            )
                            .path
                    )
                green = 0
                try {
                    for (y in
                        (bounds.top.value * density).toInt().coerceAtLeast(0) until
                            (bounds.bottom.value * density).toInt().coerceAtMost(bitmap.height) step
                            4) for (x in
                        (bounds.left.value * density).toInt().coerceAtLeast(0) until
                            (bounds.right.value * density).toInt().coerceAtMost(bitmap.width) step
                            4) if (bitmap.getPixel(x, y) == Color.rgb(51, 74, 59)) green++
                } finally {
                    bitmap.recycle()
                }
                if (green > 1000) break
                scenario.onActivity {
                    web(it.window.decorView)?.let { renderer ->
                        renderer.scrollBy(0, -maxOf(1, renderer.height / 3))
                    }
                }
                device.waitForIdle(500)
            }
            assertTrue("The cached inline image must actually render offline", green > 1000)
            assertFalse(vm.busy)
            assertTrue(File(context.filesDir, "accounts/${account.id}/inline-fixture").isFile)
            capture("original-html-offline")
        } finally {
            device.executeShellCommand("svc wifi enable")
            device.executeShellCommand("svc data enable")
            cleanup(scenario)
        }
    }
}
