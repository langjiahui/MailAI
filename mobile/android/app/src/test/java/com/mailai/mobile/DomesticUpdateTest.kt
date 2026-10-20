package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.background.AppPreferences
import com.mailai.mobile.update.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.runBlocking
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
class DomesticUpdateTest {
    private val fixture =
        JSONObject(
            requireNotNull(javaClass.classLoader!!.getResource("domestic-channel-fixture.json"))
                .readText()
        )
    private val envelope
        get() = fixture.getJSONObject("envelope").toString()

    private fun verify(raw: String) = DomesticUpdates.verify(raw, fixture.getString("public_key"))

    @Test
    fun pinnedPayloadWorksOnAndroidTenAndEnvelopeMetadataIsNeverTrusted() {
        val candidate = verify(envelope)
        assertEquals("9.0.0", candidate.version)
        assertEquals(
            "${DOMESTIC_RELEASES}download/android-v9.0.0/MailAI-Android-9.0.0.apk",
            candidate.mirrorUrl,
        )
        val extra =
            JSONObject(envelope)
                .put("manifest", JSONObject().put("url", "https://attacker.test/evil.apk"))
        assertEquals(candidate, verify(extra.toString()))
        assertThrows(IllegalArgumentException::class.java) { DomesticUpdates.discover(envelope) }
        val tampered = JSONObject(envelope)
        val payload =
            String(Base64.getDecoder().decode(tampered.getString("payload")))
                .replace("9.0.0", "9.0.1")
        tampered.put("payload", Base64.getEncoder().encodeToString(payload.toByteArray()))
        assertThrows(IllegalArgumentException::class.java) { verify(tampered.toString()) }
    }

    @Test
    fun domesticResourcesCannotUseHttpPrivateHostsOrAnotherRepository() {
        UpdatePolicy.requireUrl(DOMESTIC_MANIFEST)
        UpdatePolicy.requireUrl("https://file-cdn.gitcode.com/synthetic.apk?signature=synthetic")
        UpdatePolicy.requireUrl(verify(envelope).mirrorUrl)
        for (url in
            listOf(
                "http://atomgit.com/langjiahui2011/MailAI/releases/download/android-v9.0.0/a.apk",
                "https://raw.atomgit.com/attacker/MailAI/raw/updates/android-latest.signed.json",
                "https://atomgit.com/attacker/MailAI/releases/download/android-v9.0.0/a.apk",
                "https://10.42.0.8/a.apk",
            )) {
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireUrl(url) }
        }
    }

    @Test
    fun bothDownloadDirectionsFallBackAndDamagedBytesNeverBecomeReady() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        for (preferDomestic in listOf(false, true)) {
            val c = verify(envelope).copy(size = 3)
            context
                .getSharedPreferences("mailai.updates", Context.MODE_PRIVATE)
                .edit()
                .putString("candidate", c.json().toString())
                .putBoolean("preferDomestic", preferDomestic)
                .commit()
            val requested = mutableListOf<String>()
            val urls =
                if (preferDomestic) listOf(c.mirrorUrl, c.url) else listOf(c.url, c.mirrorUrl)
            val http =
                UpdateHttp(
                    OkHttpClient.Builder()
                        .addInterceptor { chain ->
                            requested.add(chain.request().url.toString())
                            if (requested.size == 1) throw IOException("synthetic blocked source")
                            Response.Builder()
                                .request(chain.request())
                                .protocol(Protocol.HTTP_1_1)
                                .code(200)
                                .message("OK")
                                .body("abc".toResponseBody())
                                .build()
                        }
                        .build()
                )
            val updates = AppUpdates(context)
            assertFalse(updates.fetch(c.code, http))
            assertEquals(urls, requested)
            assertEquals(UpdateFailureStage.VERIFY, updates.state.value.failureStage)
            assertFalse(updates.state.value.ready)
        }
    }

    @Test
    fun blockedGithubDiscoversSignedDomesticChannelAndPersistsPreference() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        AppPreferences(context).autoDownload = false
        val requested = mutableListOf<String>()
        val http =
            UpdateHttp(
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val url = chain.request().url.toString()
                        requested.add(url)
                        if (url == RELEASES) throw IOException("synthetic blocked GitHub")
                        assertEquals(DOMESTIC_MANIFEST, url)
                        Response.Builder()
                            .request(chain.request())
                            .protocol(Protocol.HTTP_1_1)
                            .code(200)
                            .message("OK")
                            .body(envelope.toResponseBody())
                            .build()
                    }
                    .build()
            )
        val updates = AppUpdates(context)
        assertTrue(updates.check(http, channelVerifier = ::verify))
        assertEquals(listOf(RELEASES, DOMESTIC_MANIFEST), requested)
        assertEquals(verify(envelope), updates.state.value.candidate)
        assertFalse(updates.state.value.failed)
        assertTrue(
            context
                .getSharedPreferences("mailai.updates", Context.MODE_PRIVATE)
                .getBoolean("preferDomestic", false)
        )
        assertEquals(updates.state.value.candidate, AppUpdates(context).state.value.candidate)
    }
}
