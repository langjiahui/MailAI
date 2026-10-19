package com.mailai.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mailai.mobile.background.*
import com.mailai.mobile.data.*
import com.mailai.mobile.update.*
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Keep JVM protocol fixtures on JSSE; Android Conscrypt is exercised on the emulator.
@org.robolectric.annotation.ConscryptMode(org.robolectric.annotation.ConscryptMode.Mode.OFF)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class BackgroundUpdateTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun mail(uid: Long, validity: Long = 1, unread: Boolean = true) =
        MailItem(
            "INBOX:$validity:$uid",
            "INBOX",
            validity,
            uid,
            "sender",
            "a@example.test",
            "b@example.test",
            "subject",
            1,
            unread,
        )

    @Test
    fun initialSyncIsQuietAndOnlyNewUnreadUidNotifies() {
        MailStore(context, UUID.randomUUID().toString()).use { db ->
            db.recordArrivals(1, listOf(mail(1), mail(2)))
            assertTrue(db.pendingArrivals().isEmpty())
            db.recordArrivals(1, listOf(mail(2), mail(3), mail(4, unread = false)))
            assertEquals(listOf(3L), db.pendingArrivals().map { it.uid })
            db.acknowledgeArrivals()
            db.recordArrivals(1, listOf(mail(3), mail(4)))
            assertTrue(db.pendingArrivals().isEmpty())
        }
    }

    @Test
    fun pendingSurvivesProcessRestartAndUidValidityResetsBaseline() {
        val id = UUID.randomUUID().toString()
        MailStore(context, id).use {
            it.recordArrivals(1, listOf(mail(1)))
            it.recordArrivals(1, listOf(mail(2)))
        }
        MailStore(context, id).use {
            assertEquals(2L, it.pendingArrivals().single().uid)
            it.recordArrivals(2, listOf(mail(40, 2)))
            assertTrue(it.pendingArrivals().isEmpty())
            it.recordArrivals(2, listOf(mail(41, 2)))
            assertEquals(41L, it.pendingArrivals().single().uid)
        }
    }

    @Test
    fun emptyInboxAndSmallerWindowNeverMoveCursorBackward() {
        MailStore(context, UUID.randomUUID().toString()).use {
            it.recordArrivals(1, listOf(mail(20)))
            it.recordArrivals(1, emptyList())
            it.recordArrivals(1, listOf(mail(10), mail(20)))
            assertTrue(it.pendingArrivals().isEmpty())
        }
    }

    @Test
    fun versionOneDatabaseMigratesWithoutDroppingDrafts() {
        val id = UUID.randomUUID().toString()
        val path = context.getDatabasePath("mail-$id.db")
        path.parentFile!!.mkdirs()
        val draft = Draft(body = "必须保留的旧版草稿")
        android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL(
                "CREATE TABLE messages (key TEXT PRIMARY KEY, folder TEXT NOT NULL, date INTEGER NOT NULL, payload TEXT NOT NULL)"
            )
            db.execSQL(
                "CREATE TABLE drafts (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL)"
            )
            db.execSQL(
                "INSERT INTO drafts VALUES (?,?,?,?)",
                arrayOf<Any>(draft.id, draft.updated, draft.state.name, draftJson(draft).toString()),
            )
            db.version = 1
        }
        MailStore(context, id).use {
            assertEquals(draft.body, it.draft(draft.id)?.body)
            it.recordArrivals(1, listOf(mail(1)))
            assertTrue(it.pendingArrivals().isEmpty())
            assertEquals(2, it.readableDatabase.version)
        }
    }

    @Test
    fun accountsHaveIndependentNotificationCursors() {
        MailStore(context, UUID.randomUUID().toString()).use { first ->
            MailStore(context, UUID.randomUUID().toString()).use { second ->
                first.recordArrivals(1, listOf(mail(1)))
                first.recordArrivals(1, listOf(mail(2)))
                second.recordArrivals(1, listOf(mail(2)))
                assertEquals(1, first.pendingArrivals().size)
                assertTrue(second.pendingArrivals().isEmpty())
            }
        }
    }

    @Test
    fun blockedNotificationsKeepQueueAndAcknowledgementCannotEraseNewArrivals() {
        val account =
            Account(
                email = "pending@example.test",
                imap = Server("imap.example.test"),
                smtp = Server("smtp.example.test", 465),
            )
        val repo = MailRepository(context)
        val db = repo.store(account)
        AppPreferences(context).background = true
        MailNotifications.channels(context)
        org.robolectric.Shadows.shadowOf(
                context.getSystemService(android.app.NotificationManager::class.java)
            )
            .setNotificationsEnabled(false)
        db.recordArrivals(1, listOf(mail(1)))
        db.recordArrivals(1, listOf(mail(2)))
        runBlocking { repo.deliverPending(account) }
        assertEquals(listOf(2L), db.pendingArrivals().map { it.uid })
        val snapshot = db.pendingArrivals().map { it.key }
        db.recordArrivals(1, listOf(mail(2), mail(3)))
        db.acknowledgeArrivals(snapshot)
        assertEquals(listOf(3L), db.pendingArrivals().map { it.uid })
        db.recordArrivals(1, listOf(mail(3, unread = false)))
        assertTrue(db.pendingArrivals().isEmpty())
    }

    @Test
    fun retryUsesOneSilentUpdatingCardAndUniqueMessageIntent() {
        val account =
            Account(
                email = "notice@example.test",
                imap = Server("imap.example.test"),
                smtp = Server("smtp.example.test", 465),
            )
        MailNotifications.channels(context)
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        org.robolectric.Shadows.shadowOf(manager).setNotificationsEnabled(true)
        assertTrue(MailNotifications.show(context, account, listOf(mail(2))))
        assertTrue(MailNotifications.show(context, account, listOf(mail(2))))
        assertEquals(1, manager.activeNotifications.size)
        val n = manager.activeNotifications.single().notification
        assertTrue(n.flags and android.app.Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertEquals("解锁后查看", n.publicVersion.extras.getString(android.app.Notification.EXTRA_TEXT))
        val first = MailNotifications.mailIntent(context, account, mail(2).key)
        val second = MailNotifications.mailIntent(context, account, mail(3).key)
        assertNotEquals(first.data, second.data)
        assertEquals(mail(2).key, first.getStringExtra("messageKey"))
        assertTrue(MailNotifications.show(context, account, listOf(mail(3))))
        assertEquals(1, manager.activeNotifications.size)
        val newer = manager.activeNotifications.single().notification
        assertEquals(0, newer.flags and android.app.Notification.FLAG_ONLY_ALERT_ONCE)
        assertEquals(mail(3).key, newer.extras.getString("mailai.messageKey"))
    }

    @Test
    fun backgroundNetworkDoesNotDependOnSystemProbeValidation() {
        val request = requireNotNull(BackgroundSchedule.mailConstraints().requiredNetworkRequest)
        assertTrue(request.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET))
        assertFalse(request.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED))
    }

    @Test
    fun catchUpChecksOnlyStaleFailedOrClockResetAccounts() {
        val prefs = AppPreferences(context)
        prefs.interval = 15
        assertTrue(prefs.needsSync("new"))
        prefs.syncResult("recent", true)
        val now = prefs.data.getLong("sync.recent.time", 0)
        assertFalse(prefs.needsSync("recent", now + 60_000))
        assertTrue(prefs.needsSync("recent", now + 900_000))
        assertTrue(prefs.needsSync("recent", now - 1))
        prefs.syncResult("recent", false)
        assertTrue(prefs.needsSync("recent"))
    }

    @Test
    fun updateUrlsRejectPrivateTargetsCredentialsAndLookalikeHosts() {
        UpdatePolicy.requireUrl(
            "https://api.github.com/repos/langjiahui/MailAI/releases?per_page=30"
        )
        UpdatePolicy.requireUrl("https://release-assets.githubusercontent.com/a/b?token=synthetic")
        listOf(
                "http://github.com/langjiahui/MailAI/releases/download/v/a.apk",
                "https://127.0.0.1/a",
                "https://github.com.evil.test/a",
                "https://user@github.com/langjiahui/MailAI/releases/download/v/a",
                "https://github.com:444/langjiahui/MailAI/releases/download/v/a",
                "https://github.com/other/repo/releases/download/v/a",
                "https://api.github.com/user",
            )
            .forEach {
                assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireUrl(it) }
            }
    }

    @Test
    fun updateManifestMustMatchPackageTagAssetSizeAndHash() {
        val tag = "android-v2.10.0-beta.2"
        val c =
            UpdateCandidate(
                "2.10.0-beta.2",
                2100002,
                "$RELEASE_PREFIX$tag/MailAI.apk",
                "a".repeat(64),
                1234,
                "更新说明",
                "https://github.com/langjiahui/MailAI/releases/tag/$tag",
            )
        val assets =
            JSONArray().put(JSONObject().put("browser_download_url", c.url).put("size", c.size))
        fun manifest() = c.json().put("schema", 1).put("applicationId", BuildConfig.APPLICATION_ID)
        assertEquals(c, UpdatePolicy.manifest(manifest(), tag, assets))
        listOf(
                "applicationId" to "other.app",
                "sha256" to "not-a-sha",
                "size" to MAX_APK + 1,
                "version" to "2.10.0-beta.3",
                "page" to "https://evil.test",
            )
            .forEach { (key, value) ->
                assertThrows(IllegalArgumentException::class.java) {
                    UpdatePolicy.manifest(manifest().put(key, value), tag, assets)
                }
            }
        assertThrows(IllegalArgumentException::class.java) {
            UpdatePolicy.manifest(manifest(), tag, JSONArray())
        }
    }

    @Test
    fun workCancellationClosesBlockedOperationPromptly() = runBlocking {
        val started = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val job = launch {
            cancellableIo({ closed.countDown() }) {
                started.countDown()
                closed.await(10, TimeUnit.SECONDS)
            }
        }
        withContext(Dispatchers.IO) { assertTrue(started.await(3, TimeUnit.SECONDS)) }
        job.cancel()
        withTimeout(3000) { job.join() }
        assertEquals(0L, closed.count)
    }

    @Test
    fun notificationPreviewIsPrivateByDefaultAndPreferencesPersist() {
        val prefs = AppPreferences(context)
        assertFalse(prefs.previews)
        prefs.interval = 30
        prefs.previews = true
        prefs.background = false
        val reopened = AppPreferences(context)
        assertEquals(30, reopened.interval)
        assertTrue(reopened.previews)
        assertFalse(reopened.background)
        assertThrows(IllegalArgumentException::class.java) { prefs.interval = 1 }
    }
}
