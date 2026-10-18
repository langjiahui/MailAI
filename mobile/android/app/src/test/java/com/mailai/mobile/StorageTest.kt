package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.data.*
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Keep JVM protocol fixtures on JSSE; Android Conscrypt is exercised on the emulator.
@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class StorageTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun draftSurvivesDatabaseReopenAndIsAccountIsolated() {
        val first = UUID.randomUUID().toString()
        val second = UUID.randomUUID().toString()
        val d =
            Draft(
                to = "synthetic@example.test",
                body = "中文草稿",
                attachments = listOf(Attachment("", "报价.pdf", "application/pdf", 12, "fixture")),
            )
        MailStore(context, first).use { it.save(d) }
        MailStore(context, first).use {
            assertEquals(d.body, it.draft(d.id)?.body)
            assertEquals("报价.pdf", it.draft(d.id)?.attachments?.first()?.name)
        }
        MailStore(context, second).use { assertTrue(it.drafts().isEmpty()) }
    }

    @Test
    fun processDeathNeverTurnsTransmittingIntoRetryableDraft() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            val connecting = Draft(body = "connecting")
            val sending = Draft(body = "sending")
            store.save(connecting)
            store.save(sending)
            store.transition(connecting.id, setOf(SendState.DRAFT), SendState.CONNECTING)
            store.transition(sending.id, setOf(SendState.DRAFT), SendState.TRANSMITTING)
            store.recoverInterrupted()
            assertEquals(SendState.FAILED, store.draft(connecting.id)?.state)
            assertEquals(SendState.UNCERTAIN, store.draft(sending.id)?.state)
            try {
                store.save(sending)
                fail("must not overwrite uncertain")
            } catch (_: IllegalStateException) {}
            try {
                store.transition(sending.id, setOf(SendState.DRAFT), SendState.CONNECTING)
                fail("must not resend")
            } catch (_: IllegalStateException) {}
        }
    }

    @Test
    fun uidValidityChangeCannotReuseBodyOrFiles() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            val old =
                MailItem(
                    "INBOX:1:7",
                    "INBOX",
                    1,
                    7,
                    "a",
                    "a",
                    "b",
                    "old",
                    1,
                    true,
                    body = "old body",
                    attachments = listOf(Attachment("0", "a", "text/plain", 1, "old-file")),
                )
            store.put(old)
            store.replaceWindow(
                "INBOX",
                2,
                listOf(
                    old.copy(
                        key = "INBOX:2:7",
                        validity = 2,
                        body = null,
                        attachments = emptyList(),
                    )
                ),
            )
            assertNull(store.messages("INBOX").single().body)
            assertTrue(store.messages("INBOX").single().attachments.isEmpty())
        }
    }

    @Test
    fun changingAnAccountIdentityCannotReuseItsLocalData() {
        val cipher =
            object : SecretCipher {
                override fun encrypt(text: String) = text.reversed()

                override fun decrypt(text: String) = text.reversed()
            }
        val accounts = AccountStore(context, cipher)
        val a =
            Account(
                email = "original@example.test",
                imap = Server("imap.example.test"),
                smtp = Server("smtp.example.test", 465),
            )
        accounts.put(a, "fixture-only")
        try {
            accounts.put(a.copy(email = "different@example.test"), "fixture-only")
            fail("must require new account identity")
        } catch (_: IllegalArgumentException) {}
        assertEquals(a.email, accounts.all().single().email)
    }

    @Test
    fun sameUidInDifferentFoldersRemainsDistinct() {
        MailStore(context, UUID.randomUUID().toString()).use { store ->
            val m = MailItem("INBOX:1:7", "INBOX", 1, 7, "a", "a", "b", "inbox", 1, true)
            store.put(m)
            store.put(m.copy(key = "Sent:1:7", folder = "Sent", subject = "sent"))
            store.replaceWindow("INBOX", 1, emptyList())
            assertEquals("sent", store.messages("Sent").single().subject)
        }
    }
}
