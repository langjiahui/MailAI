package com.mailai.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.mailai.mobile.background.AppPreferences
import com.mailai.mobile.data.*
import com.mailai.mobile.mail.MailContact
import com.mailai.mobile.ui.MailViewModel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ContactEditingTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun editedNameSurvivesLaterMailAndTheContactStillStartsACompose() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account =
            Account(
                id = "23b057cd-65b1-437f-abf9-5d29fa101a01",
                email = "fixture@example.test",
                imap = Server("127.0.0.1", 993),
                smtp = Server("127.0.0.1", 465),
            )
        AccountStore(context).put(account, "synthetic-test-secret")
        AccountStore(context).all().forEach { AppPreferences(context).syncResult(it.id, true) }
        val repo = (context.applicationContext as MailApplication).repository
        repo.store(account).saveContact(MailContact("manual-edit@example.test", "林海"))
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var vm: MailViewModel
        try {
            scenario.onActivity { vm = ViewModelProvider(it)[MailViewModel::class.java] }
            compose.waitUntil(15000) { vm.ready && !vm.busy }
            if (vm.account?.id != account.id) {
                scenario.onActivity { vm.choose(account) }
                compose.waitUntil(15000) { vm.account?.id == account.id && !vm.busy }
            }
            scenario.onActivity { vm.go("contacts") }
            compose.onNode(hasSetTextAction() and hasText("搜索联系人")).performTextInput("manual-edit")
            compose.onNode(hasSetTextAction() and hasText("manual-edit")).performImeAction()
            compose.onNodeWithText("林海").assertExists()
            compose
                .onNodeWithContentDescription("联系人操作")
                .performScrollTo()
                .assertIsDisplayed()
                .performClick()
            compose.onNodeWithText("编辑联系人").performClick()
            compose.onNodeWithText("姓名（选填）").performTextReplacement("林老师")
            compose.onNodeWithText("邮箱地址").assertIsNotEnabled()
            compose.onNodeWithText("保存联系人").performClick()
            compose.waitUntil(10000) {
                !vm.busy &&
                    vm.contacts.any { it.email == "manual-edit@example.test" && it.name == "林老师" }
            }
            repo.store(account).rememberContacts("后来的邮件名称 <manual-edit@example.test>")
            assertEquals(
                "林老师",
                repo
                    .store(account)
                    .contacts()
                    .single { it.email == "manual-edit@example.test" }
                    .name,
            )
            compose.onNodeWithText("林老师").performClick()
            compose.waitUntil(10000) { vm.page == "compose" }
            assertTrue(vm.draft?.to.orEmpty().contains("manual-edit@example.test"))
        } finally {
            scenario.close()
        }
    }
}
