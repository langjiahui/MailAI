package com.mailai.mobile.background

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import com.mailai.mobile.MailApplication
import com.mailai.mobile.MainActivity
import com.mailai.mobile.R
import com.mailai.mobile.data.Account
import com.mailai.mobile.data.MailItem
import com.mailai.mobile.mail.Operation
import com.mailai.mobile.update.UpdateCheckWorker
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*

class AppPreferences(context: Context) {
    val data = context.getSharedPreferences("mailai.preferences", Context.MODE_PRIVATE)
    var background: Boolean
        get() = data.getBoolean("background", true)
        set(value) {
            data.edit().putBoolean("background", value).apply()
        }

    var interval: Int
        get() = data.getInt("interval", 15).let { if (it in listOf(15, 30, 60)) it else 15 }
        set(value) {
            require(value in listOf(15, 30, 60))
            data.edit().putInt("interval", value).apply()
        }

    var previews: Boolean
        get() = data.getBoolean("previews", false)
        set(value) {
            data.edit().putBoolean("previews", value).apply()
        }

    var autoCheck: Boolean
        get() = data.getBoolean("autoCheck", true)
        set(value) {
            data.edit().putBoolean("autoCheck", value).apply()
        }

    var autoDownload: Boolean
        get() = data.getBoolean("autoDownload", true)
        set(value) {
            data.edit().putBoolean("autoDownload", value).apply()
        }

    fun needsSync(id: String, now: Long = System.currentTimeMillis()): Boolean {
        val time = data.getLong("sync.$id.time", 0)
        return !data.getBoolean("sync.$id.ok", false) ||
            time == 0L ||
            now < time ||
            now - time >= TimeUnit.MINUTES.toMillis(interval.toLong())
    }

    fun syncResult(id: String, ok: Boolean) {
        data
            .edit()
            .putLong("sync.$id.time", System.currentTimeMillis())
            .putBoolean("sync.$id.ok", ok)
            .apply()
    }
}

object BackgroundSchedule {
    // Mail servers may be reachable even when the OS connectivity probe is blocked.
    // Keep a real network constraint and let the TLS mail connection determine reachability.
    fun mailConstraints(): Constraints =
        Constraints.Builder()
            .setRequiredNetworkRequest(
                android.net.NetworkRequest.Builder()
                    .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                NetworkType.CONNECTED,
            )
            .build()

    /** A durable, network-constrained catch-up after returning from sleep or system settings. */
    fun catchUp(context: Context) {
        if (!AppPreferences(context).background) return
        val request =
            OneTimeWorkRequestBuilder<MailSyncWorker>()
                .setInputData(workDataOf("catchUp" to true))
                .setConstraints(mailConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork("mail-catch-up", ExistingWorkPolicy.KEEP, request)
    }

    fun configure(context: Context) {
        val prefs = AppPreferences(context)
        val manager = WorkManager.getInstance(context)
        if (prefs.background) {
            val work =
                PeriodicWorkRequestBuilder<MailSyncWorker>(
                        prefs.interval.toLong(),
                        TimeUnit.MINUTES,
                    )
                    .setConstraints(mailConstraints())
                    .setInitialDelay(15, TimeUnit.MINUTES)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                    .build()
            manager.enqueueUniquePeriodicWork("mail-sync", ExistingPeriodicWorkPolicy.UPDATE, work)
        } else {
            manager.cancelUniqueWork("mail-sync")
            manager.cancelUniqueWork("mail-catch-up")
        }
        if (prefs.autoCheck) {
            val work =
                PeriodicWorkRequestBuilder<UpdateCheckWorker>(24, TimeUnit.HOURS)
                    .setConstraints(
                        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                    )
                    .setInitialDelay(10, TimeUnit.MINUTES)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
                    .build()
            manager.enqueueUniquePeriodicWork(
                "update-check",
                ExistingPeriodicWorkPolicy.UPDATE,
                work,
            )
        } else manager.cancelUniqueWork("update-check")
        if (!prefs.autoDownload) manager.cancelUniqueWork("update-auto-download")
    }
}

object MailNotifications {
    const val CHANNEL = "mail-arrivals"
    const val UPDATES = "app-updates"

    fun channels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "新邮件", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "后台收取到的新邮件"
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(UPDATES, "应用更新", NotificationManager.IMPORTANCE_LOW)
        )
    }

    fun allowed(context: Context, channel: String = CHANNEL): Boolean {
        if (
            Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
        )
            return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            context
                .getSystemService(NotificationManager::class.java)
                .getNotificationChannel(channel)
                ?.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun mailIntent(context: Context, account: Account, key: String): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = "com.mailai.OPEN_MAIL"
            data =
                android.net.Uri.Builder()
                    .scheme("mailai")
                    .authority("mail")
                    .appendPath(account.id)
                    .appendPath(key)
                    .build()
            putExtra("accountId", account.id)
            putExtra("messageKey", key)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }

    /** Only acknowledge the durable queue after Android accepts the notification. */
    fun show(context: Context, account: Account, mails: List<MailItem>): Boolean {
        if (mails.isEmpty()) return true
        if (!allowed(context)) return false
        val latest = mails.maxBy { it.uid }
        val intent = mailIntent(context, account, latest.key)
        val pending =
            PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val preview = AppPreferences(context).previews
        val notification =
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(if (preview) latest.sender else "MailAI · 有新邮件")
                .setContentText(if (preview) latest.subject else "轻点查看最新邮件")
                .setSubText(if (mails.size > 1) "${mails.size} 封新邮件" else "")
                .setContentIntent(pending)
                .setAutoCancel(true)
                // Retrying after process death updates the existing card without another alert.
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory(NotificationCompat.CATEGORY_EMAIL)
                .setPublicVersion(
                    NotificationCompat.Builder(context, CHANNEL)
                        .setSmallIcon(R.drawable.ic_notification)
                        .setContentTitle("MailAI · 有新邮件")
                        .setContentText("解锁后查看")
                        .build()
                )
                .build()
        return try {
            NotificationManagerCompat.from(context).notify("mail.${account.id}", 1, notification)
            true
        } catch (_: SecurityException) {
            false // Permission may be revoked between check and post; keep the queue.
        }
    }

    fun update(context: Context, ready: Boolean) {
        if (!allowed(context, UPDATES)) return
        val intent =
            Intent(context, MainActivity::class.java).apply {
                action = "com.mailai.OPEN_UPDATES"
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
        val pending =
            PendingIntent.getActivity(
                context,
                2,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val n =
            NotificationCompat.Builder(context, UPDATES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(if (ready) "MailAI 更新已准备好" else "MailAI 有新版本")
                .setContentText(if (ready) "轻点查看并安装，邮件和草稿会保留" else "轻点查看更新内容")
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build()
        try {
            NotificationManagerCompat.from(context).notify("updates", 2, n)
        } catch (_: SecurityException) {}
    }
}

class MailSyncWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
    private val operation = Operation()

    override suspend fun doWork(): Result =
        cancellableIo(operation::cancel) {
            val prefs = AppPreferences(applicationContext)
            if (!prefs.background) return@cancellableIo Result.success()
            val repo = (applicationContext as MailApplication).repository
            var failed = false
            try {
                for (account in repo.initialize()) {
                    if (!prefs.background || isStopped) break
                    try {
                        repo.deliverPending(account)
                        if (
                            !inputData.getBoolean("catchUp", false) || prefs.needsSync(account.id)
                        ) {
                            repo.sync(account, "INBOX", 50, operation)
                            prefs.syncResult(account.id, true)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        failed = true
                        prefs.syncResult(account.id, false)
                    }
                }
                if (failed && runAttemptCount < 3) Result.retry() else Result.success()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (runAttemptCount < 3) Result.retry() else Result.failure()
            } finally {
                operation.release()
            }
        }
}

/** Closing sockets on cancellation makes WorkManager stop promptly, including blocked reads. */
internal suspend fun <T> cancellableIo(cancel: () -> Unit, block: suspend () -> T): T =
    coroutineScope {
        val monitor =
            launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
                try {
                    awaitCancellation()
                } finally {
                    cancel()
                }
            }
        try {
            withContext(Dispatchers.IO) { block() }
        } finally {
            monitor.cancel()
        }
    }
