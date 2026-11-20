package com.mailai.mobile

import com.mailai.mobile.mail.MailAddresses
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeUtility
import org.junit.Assert.*
import org.junit.Test

class MailAddressEscapingTest {
    @Test
    fun escapedDisplayNamesAreCleanedAtNetworkAndCacheBoundaries() {
        val email = "person@example.test"
        val escapedName = "\\\"张三\\\""
        assertEquals("张三", MailAddresses.decode(escapedName))
        for (raw in listOf(
            "$escapedName <$email>",
            "${MimeUtility.encodeText(escapedName, "UTF-8", "B")} <$email>",
        )) {
            val sender = MailAddresses.sender(raw)
            assertEquals(email, sender.email)
            assertEquals("张三", sender.label)
            val cachedHeader = MailAddresses.display(raw)
            assertEquals(sender, MailAddresses.sender(cachedHeader))
            val deliveryAddress = InternetAddress.parse(cachedHeader, true).single()
            deliveryAddress.validate()
            assertEquals(email, deliveryAddress.address)
        }
        assertEquals(email, MailAddresses.decode("\\\"$email\\\""))
        assertEquals(email, MailAddresses.sender("\\\"$email\\\"").label)
        assertEquals("研发\\支持", MailAddresses.decode("研发\\支持"))
        assertEquals("Jane \"JJ\" Doe", MailAddresses.decode("Jane \"JJ\" Doe"))
    }

    @Test
    fun punctuationAndMultipleRecipientsKeepTheirNamesAndDeliveryAddresses() {
        for (name in listOf("张三, 项目;采购", "张三\"采购\"", "张三\\采购", "O'Connor")) {
            val encoded = MimeUtility.encodeText(name, "UTF-8", "B")
            val contacts = MailAddresses.parse("$encoded <person@example.test>, other@example.test")
            assertEquals(listOf("person@example.test", "other@example.test"), contacts.map { it.email })
            assertEquals(name, contacts.first().label)
            val displayed = MailAddresses.display("$encoded <person@example.test>, other@example.test")
            assertEquals(contacts, MailAddresses.parse(displayed))
        }
        assertEquals("\\\"unfinished", MailAddresses.decode("\\\"unfinished"))
        assertEquals("name\\", MailAddresses.decode("name\\"))
        assertEquals("张三", MailAddresses.decode("\"\\\"张三\\\"\""))
    }
}
