package com.mailai.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.mailai.mobile.mail.MailAddresses
import com.mailai.mobile.mail.MailContact
import com.mailai.mobile.mail.MailHeaderCodec
import java.nio.charset.Charset
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HeaderEncodingDeviceTest {
    @Test
    fun androidCharsetRestoresMislabeledChineseNamesAndPreservesRecipientSyntax() {
        val name = "测试镕, 项目;采购"
        val payload = Base64.getEncoder().encodeToString(name.toByteArray(Charset.forName("GBK")))
        for (label in listOf("gb2312", "utf-8", "unknown-charset")) {
            val encoded = "=?$label?B?$payload?="
            assertEquals(name, MailHeaderCodec.decode(encoded))
            val people = MailAddresses.parse("$encoded <person@example.test>, other@example.test")
            assertEquals(
                listOf(MailContact("person@example.test", name), MailContact("other@example.test")),
                people,
            )
            assertEquals(
                people,
                MailAddresses.parse(
                    MailAddresses.display("$encoded <person@example.test>, other@example.test")
                ),
            )
        }
    }
}
