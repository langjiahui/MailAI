package com.mailai.mobile

import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.data.ReadingPreferences
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReadingPreferencesTest {
    @Test
    fun concurrentStarsSurviveReloadAndStayScopedToAccount() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        ReadingPreferences(context).data.edit().clear().commit()
        val workers = Executors.newFixedThreadPool(4)
        try {
            val jobs =
                (1..64).map { key ->
                    workers.submit {
                        ReadingPreferences(context).star("account-a", "INBOX:1:$key", true)
                    }
                }
            jobs.forEach { it.get(10, TimeUnit.SECONDS) }
            val reloaded = ReadingPreferences(context)
            assertEquals(64, reloaded.stars("account-a").size)
            assertTrue(reloaded.stars("account-b").isEmpty())
            reloaded.star("account-a", "INBOX:1:1", false)
            assertEquals(63, ReadingPreferences(context).stars("account-a").size)
        } finally {
            workers.shutdownNow()
            ReadingPreferences(context).data.edit().clear().commit()
        }
    }

    @Test
    fun readingChoicesAndAccountSignatureSurviveRecreation() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = ReadingPreferences(context)
        prefs.data.edit().clear().commit()
        try {
            prefs.theme = "dark"
            prefs.bodySize = 20
            prefs.signature("a", "林安\n研发团队")
            val reloaded = ReadingPreferences(context)
            assertEquals("dark", reloaded.theme)
            assertEquals(20, reloaded.bodySize)
            assertEquals("林安\n研发团队", reloaded.signature("a"))
            assertEquals("", reloaded.signature("b"))
        } finally {
            prefs.data.edit().clear().commit()
        }
    }
}
