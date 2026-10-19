package com.mailai.mobile.background

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.mail.AuthenticationFailedException
import javax.net.ssl.SSLException

/** Local diagnostics deliberately separate from successful foreground refreshes. No mail text. */
class BackgroundHealth(context: Context) {
    private val data =
        context.getSharedPreferences("mailai.background-health", Context.MODE_PRIVATE)

    data class Check(val started: Long, val finished: Long, val failure: String) {
        val interrupted: Boolean
            get() = started > finished
    }

    fun check(id: String) =
        Check(
            data.getLong("$id.start", 0),
            data.getLong("$id.finish", 0),
            data.getString("$id.failure", "").orEmpty(),
        )

    fun started(id: String) {
        // Commit before network I/O so process death cannot turn an unfinished check into success.
        data
            .edit()
            .putLong("$id.start", System.currentTimeMillis())
            .putLong("$id.finish", 0)
            .putString("$id.failure", "")
            .commit()
    }

    fun finished(id: String, failure: String = "") {
        data
            .edit()
            .putLong("$id.finish", System.currentTimeMillis())
            .putString("$id.failure", failure)
            .commit()
    }

    companion object {
        fun failure(error: Throwable): String {
            var current: Throwable? = error
            repeat(12) {
                when (current) {
                    is AuthenticationFailedException -> return "login"
                    is SSLException -> return "tls"
                    is UnknownHostException -> return "dns"
                    is SocketTimeoutException -> return "timeout"
                    is ConnectException -> return "connect"
                    is android.database.sqlite.SQLiteException -> return "storage"
                }
                current = current?.cause
            }
            return "connection"
        }

        fun explanation(code: String): String =
            when (code) {
                "login" -> "登录未通过，请检查邮箱密码或授权码"
                "tls" -> "安全连接未通过，请检查邮箱服务器与证书"
                "dns" -> "无法解析服务器，请检查 Wi-Fi、VPN 与服务器地址"
                "timeout" -> "连接超时，请检查网络及邮箱端口是否可用"
                "connect" -> "无法连接服务器，请检查当前 Wi-Fi 或 VPN"
                "storage" -> "本地存储未完成，请检查手机可用空间"
                "interrupted" -> "检查被中断，下次会继续；已保存邮件和草稿保留"
                else -> "连接未完成，联网后会重试；也可点“立即检查收信”"
            }
    }
}

object BackgroundAccess {
    val xiaomi: Boolean
        get() =
            Build.MANUFACTURER.equals("xiaomi", true) ||
                Build.MANUFACTURER.equals("redmi", true) ||
                Build.BRAND.equals("poco", true)

    data class State(val restricted: Boolean, val saving: Boolean, val optimized: Boolean)

    fun state(context: Context): State {
        val power = context.getSystemService(PowerManager::class.java)
        return State(
            context.getSystemService(ActivityManager::class.java).isBackgroundRestricted,
            power.isPowerSaveMode,
            !power.isIgnoringBatteryOptimizations(context.packageName),
        )
    }

    /**
     * Vendor pages aren't a public API. Always fall back; never infer permission from opening one.
     */
    fun open(context: Context, destination: String): Boolean {
        val fallback =
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}"),
            )
        val preferred =
            when (destination) {
                "autostart" ->
                    Intent()
                        .setComponent(
                            ComponentName(
                                "com.miui.securitycenter",
                                "com.miui.permcenter.autostart.AutoStartManagementActivity",
                            )
                        )
                "battery" ->
                    if (xiaomi) fallback
                    else Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                "notifications" ->
                    Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, MailNotifications.CHANNEL)
                else -> fallback
            }
        for (intent in listOf(preferred, fallback)) {
            try {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (_: android.content.ActivityNotFoundException) {} catch (
                _: SecurityException) {}
        }
        return false
    }
}
