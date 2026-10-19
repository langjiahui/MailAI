package com.mailai.mobile

import com.mailai.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class AccountSetupTest {
    @Test
    fun matchingIsExactAndUnknownDomainsHaveNoGuessedServers() {
        assertEquals("imap.qq.com", AccountSetup.profile("A@QQ.COM ")?.imap)
        assertEquals("imap.qq.com", AccountSetup.profile("a@foxmail.com")?.imap)
        assertEquals("imap.163.com", AccountSetup.profile("a@163.com")?.imap)
        assertNull(AccountSetup.profile("a@company.example"))
        assertNull(AccountSetup.profile("a@qq.com.company.example"))
        assertNull(AccountSetup.profile("qq.com"))
    }

    @Test
    fun wrongPresetIsRejectedBeforeCredentialSubmission() {
        val account =
            Account(
                email = "user@company.example",
                imap = Server("imap.qq.com"),
                smtp = Server("smtp.qq.com", 465),
            )
        assertThrows(IllegalArgumentException::class.java) {
            AccountSetup.requireMatchingProvider(account)
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccountSetup.requireMatchingProvider(
                account.copy(imap = Server("imap.company.example"))
            )
        }
        AccountSetup.requireMatchingProvider(account.copy(email = "user@foxmail.com"))
        AccountSetup.requireMatchingProvider(
            account.copy(
                imap = Server("imap.company.example"),
                smtp = Server("smtp.company.example", 465),
            )
        )
    }
}
