package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import com.mailai.mobile.assistant.*
import com.mailai.mobile.data.*
import com.mailai.mobile.ui.MailViewModel
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Uses durable, account-bound candidate fixtures; no real model or mailbox credentials. */
@RunWith(AndroidJUnit4::class)
class AssistantExperienceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val device
        get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private val config =
        AssistantConfig(
            "https://model.example.test/v1/chat/completions",
            "fixture-model",
            "synthetic-assistant-key",
        )
    private val account =
        Account(
            id = "08a057cd-65b1-437f-abf9-5d29fa101a01",
            email = "xiaoyou@example.test",
            imap = Server("127.0.0.1", 993),
            smtp = Server("127.0.0.1", 465),
        )
    private val mail =
        MailItem(
            "INBOX:71:1",
            "INBOX",
            71,
            1,
            "陈予 <chen@example.test>",
            "chen@example.test",
            account.email,
            "周五安排确认",
            1,
            false,
            "周五前确认会议安排。",
        )

    private fun launch(): Pair<ActivityScenario<MainActivity>, MailViewModel> {
        ReadingPreferences(context).data.edit().clear().commit()
        AssistantSettings(context).save(config)
        AssistantCache(context).use { it.clear() }
        AccountStore(context).put(account, "synthetic-mail-secret")
        MailStore(context, account.id).use {
            it.writableDatabase.delete("messages", null, null)
            it.writableDatabase.delete("drafts", null, null)
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
        scenario.onActivity { vm.read(mail) }
        compose.waitUntil(10000) { !vm.busy && vm.page == "reader" }
        return scenario to vm
    }

    private fun seed(vm: MailViewModel, task: AssistantTask, text: String) {
        compose.waitUntil(10000) { !vm.assistant.loading }
        val source = requireNotNull(vm.assistant.source)
        AssistantCache(context).use {
            it.put(
                account.id,
                AssistantResult(source.cacheKey(config, task, vm.assistant.instruction), text, true),
            )
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        device.waitForIdle(500)
        if (name.substringBefore('-') in setOf("00", "01", "02", "04", "05")) {
            val close = requireNotNull(device.findObject(By.text("关闭")))
            val statusBar = context.resources.getIdentifier("status_bar_height", "dimen", "android")
            val safeTop =
                if (statusBar == 0) 0 else context.resources.getDimensionPixelSize(statusBar)
            assertTrue("小邮关闭按钮不能被系统状态栏遮挡", close.visibleBounds.top >= safeTop)
        }
        val dir = File(context.getExternalFilesDir(null), "xiaoyou-checks").apply { mkdirs() }
        assertTrue(device.takeScreenshot(File(dir, "$name.png")))
    }

    @Test
    fun summaryHasSourceAndReturnsToTheSameMailAcrossRotation() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("xiaoyou-open").performClick()
            seed(vm, AssistantTask.SUMMARY, "• 周五前确认会议安排。\n• 具体时间尚未说明。")
            compose.onAllNodesWithText("设置", substring = false).assertCountEquals(0)
            capture("00-actions")
            compose.onNodeWithText("提炼要点", substring = false).performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.complete && !vm.assistant.generating }
            compose.onNodeWithTag("xiaoyou-result").assertExists()
            capture("01-summary")
            scenario.recreate()
            compose.onNodeWithTag("xiaoyou-result").assertExists()
            compose.onNodeWithText("关闭", substring = false).performClick()
            compose.onNodeWithText(mail.subject).assertExists()
            assertEquals(mail.key, vm.selected?.key)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun replyPreviewIsAdoptedAsDurableDraftAndNeverSent() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("xiaoyou-open").performClick()
            seed(vm, AssistantTask.REPLY, "收到，我会核对后回复。")
            compose.onNodeWithText("起草回复", substring = false).performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.complete && !vm.assistant.generating }
            assertTrue(vm.repo.store(account).drafts().isEmpty())
            capture("02-reply-preview")
            compose.onNodeWithTag("xiaoyou-adopt").assertIsDisplayed().performClick()
            compose.waitUntil(10000) { vm.page == "compose" && !vm.busy }
            val saved = vm.repo.store(account).drafts().single()
            assertEquals("收到，我会核对后回复。", saved.body)
            assertEquals("chen@example.test", saved.to)
            assertEquals(SendState.DRAFT, saved.state)
            capture("03-adopted-reply")
        } finally {
            scenario.close()
        }
    }

    @Test
    fun polishKeepsOriginalUntilAdoptionAndSupportsUndo() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity {
                vm.compose(reply = true)
                vm.update(vm.draft!!.copy(body = "请确认安排。"))
            }
            compose.onNodeWithTag("xiaoyou-polish").performScrollTo().performClick()
            seed(vm, AssistantTask.POLISH, "烦请确认相关安排，谢谢。")
            compose.onNodeWithText("润色文字", substring = false).performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.complete && !vm.assistant.generating }
            assertEquals("请确认安排。", vm.draft?.body)
            capture("04-polish-preview")
            compose.onNodeWithTag("xiaoyou-adopt").performClick()
            compose.waitUntil(10000) { !vm.busy && !vm.assistant.visible }
            assertEquals("烦请确认相关安排，谢谢。", vm.draft?.body)
            compose.onNodeWithText("撤回润色").performScrollTo().performClick()
            compose.waitUntil(10000) { !vm.busy && vm.draft?.body == "请确认安排。" }
            assertEquals("请确认安排。", vm.repo.store(account).draft(vm.draft!!.id)?.body)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun staleCandidateCannotOverwriteNewTyping() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity {
                vm.compose(reply = true)
                vm.update(vm.draft!!.copy(body = "原文字"))
                vm.openAssistant()
            }
            seed(vm, AssistantTask.POLISH, "候选文字")
            compose.onNodeWithText("润色文字", substring = false).performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.complete && !vm.assistant.generating }
            scenario.onActivity { vm.update(vm.draft!!.copy(body = "用户后续输入不能丢")) }
            compose.onNodeWithTag("xiaoyou-adopt").performClick()
            compose.waitUntil(10000) { vm.assistant.failed }
            assertEquals("用户后续输入不能丢", vm.draft?.body)
            assertTrue(vm.assistant.message.contains("正文已变化"))
            capture("05-stale-candidate")
        } finally {
            scenario.close()
        }
    }

    @Test
    fun settingsRequireScopeConsentAndStoreTheKeyEncrypted() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.openAssistantSettings() }
            compose.waitUntil(10000) { !vm.assistant.loading }
            compose.onNodeWithTag("xiaoyou-save-settings").performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.failed }
            assertTrue(vm.assistant.message.contains("请确认"))
            compose.onNodeWithTag("xiaoyou-consent").performScrollTo().performClick()
            capture("06-settings")
            compose.onNodeWithTag("xiaoyou-save-settings").performScrollTo().performClick()
            compose.waitUntil(10000) { !vm.assistant.loading && !vm.assistant.failed }
            assertFalse(
                File(context.filesDir, "assistant-settings.json")
                    .readText()
                    .contains("synthetic-assistant-key")
            )
            compose.onNodeWithContentDescription("返回").performClick()
            compose.waitUntil(5000) { vm.page == "reader" }
            assertEquals(mail.key, vm.selected?.key)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun switchingMailDismissesTheOldCandidateAndPreservesAccountIsolation() {
        val (scenario, vm) = launch()
        try {
            compose.onNodeWithTag("xiaoyou-open").performClick()
            seed(vm, AssistantTask.SUMMARY, "旧邮件要点")
            compose.onNodeWithText("提炼要点", substring = false).performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.complete && !vm.assistant.generating }
            val other = mail.copy(key = "INBOX:71:2", uid = 2, subject = "另一封邮件", body = "另一封正文")
            vm.repo.store(account).put(other)
            scenario.onActivity { vm.read(other) }
            compose.waitUntil(10000) { !vm.busy }
            assertFalse(vm.assistant.visible)
            compose.onNodeWithTag("xiaoyou-open").performClick()
            assertEquals(other.key, vm.assistant.source?.sourceId)
            assertEquals("", vm.assistant.text)
            assertFalse(vm.assistant.complete)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun firstUseRoutesToSettingsAndReturnsToTheOriginalMail() {
        val (scenario, vm) = launch()
        try {
            AssistantSettings(context).clear()
            compose.onNodeWithTag("xiaoyou-open").performClick()
            compose.waitUntil(10000) { !vm.assistant.loading }
            compose.onNodeWithText("前往设置").performScrollTo().performClick()
            compose.waitUntil(5000) { vm.page == "assistant-settings" }
            compose.onNodeWithTag("xiaoyou-provider").performScrollTo().performClick()
            compose.onNodeWithTag("xiaoyou-provider-other").performScrollTo().performClick()
            compose
                .onNodeWithTag("xiaoyou-endpoint")
                .performScrollTo()
                .performTextInput(config.endpoint)
            compose.onNodeWithTag("xiaoyou-model").performScrollTo().performTextInput(config.model)
            compose.onNodeWithTag("xiaoyou-key").performScrollTo().performTextInput(config.key)
            device.pressBack()
            compose.onNodeWithTag("xiaoyou-consent").performScrollTo().performClick()
            compose.onNodeWithTag("xiaoyou-save-settings").performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.configured && !vm.assistant.loading }
            compose.onNodeWithContentDescription("返回").performClick()
            compose.waitUntil(5000) { vm.page == "reader" }
            assertEquals(mail.key, vm.selected?.key)
            compose.onNodeWithTag("xiaoyou-open").performClick()
            compose.onNodeWithText("提炼要点", substring = false).assertExists()
            compose.onAllNodesWithText("前往设置").assertCountEquals(0)
        } finally {
            scenario.close()
        }
    }

    @Test
    fun presetSetupNeedsOnlyTheKeyAndKeepsAdvancedFieldsCollapsed() {
        val (scenario, vm) = launch()
        try {
            AssistantSettings(context).clear()
            scenario.onActivity { vm.openAssistantSettings() }
            compose.waitUntil(10000) { !vm.assistant.loading }
            compose.onNodeWithTag("xiaoyou-endpoint").assertDoesNotExist()
            compose.onNodeWithTag("xiaoyou-model").assertDoesNotExist()
            compose
                .onNodeWithTag("xiaoyou-key")
                .performScrollTo()
                .performTextInput("synthetic-deepseek-key")
            device.pressBack()
            compose.onNodeWithTag("xiaoyou-consent").performScrollTo().performClick()
            compose.onNodeWithTag("xiaoyou-save-settings").performScrollTo().performClick()
            compose.waitUntil(10000) { vm.assistant.configured && !vm.assistant.loading }
            assertFalse(vm.assistant.failed)
            val saved = AssistantSettings(context).read()!!
            assertEquals(AssistantProviders.get("deepseek").endpoint, saved.endpoint)
            assertEquals("deepseek-flash", saved.model)
            assertEquals("synthetic-deepseek-key", saved.key)
            assertEquals("deepseek", saved.provider)
            capture("07-preset-setup")
        } finally {
            scenario.close()
        }
    }

    @Test
    fun changingProviderClearsTypedKeyAndProbeValidationDoesNotReplaceTheSavedConfig() {
        val (scenario, vm) = launch()
        try {
            scenario.onActivity { vm.openAssistantSettings() }
            compose.waitUntil(10000) { !vm.assistant.loading }
            compose
                .onNodeWithTag("xiaoyou-key")
                .performScrollTo()
                .performTextInput("must-not-cross-provider")
            device.pressBack()
            compose.onNodeWithTag("xiaoyou-provider").performScrollTo().performClick()
            capture("08-provider-menu")
            compose.onNodeWithTag("xiaoyou-provider-kimi_code").performScrollTo().performClick()
            compose
                .onNodeWithTag("xiaoyou-key")
                .assert(
                    SemanticsMatcher.expectValue(
                        androidx.compose.ui.semantics.SemanticsProperties.EditableText,
                        androidx.compose.ui.text.AnnotatedString(""),
                    )
                )
            compose.onNodeWithTag("xiaoyou-consent").performScrollTo().performClick()
            compose.onNodeWithTag("xiaoyou-test-settings").performScrollTo().performClick()
            compose.waitUntil(5000) { vm.assistant.verificationFailed }
            assertTrue(vm.assistant.verificationMessage.contains("API Key"))
            assertFalse(vm.assistant.testing)
            assertEquals(config, AssistantSettings(context).read())
            capture("09-probe-validation")
        } finally {
            scenario.close()
        }
    }
}
