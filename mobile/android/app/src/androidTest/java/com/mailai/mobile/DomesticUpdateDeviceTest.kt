package com.mailai.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mailai.mobile.update.DomesticUpdates
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DomesticUpdateDeviceTest {
    @Test
    fun installedAppVerifiesTheSameSignedPayloadWithoutProviderRegistration() {
        val fixture =
            InstrumentationRegistry.getInstrumentation()
                .context
                .assets
                .open("domestic-channel-fixture.json")
                .bufferedReader()
                .use { JSONObject(it.readText()) }
        val candidate =
            DomesticUpdates.verify(
                fixture.getJSONObject("envelope").toString(),
                fixture.getString("public_key"),
            )
        assertEquals("9.0.0", candidate.version)
        assertTrue(
            candidate.mirrorUrl.startsWith(
                "https://atomgit.com/langjiahui2011/MailAI/releases/download/android-v9.0.0/"
            )
        )
        assertThrows(IllegalArgumentException::class.java) {
            DomesticUpdates.discover(fixture.getJSONObject("envelope").toString())
        }
    }
}
