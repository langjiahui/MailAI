package com.mailai.mobile.data

import android.content.Context

/** Local presentation preferences never change the message on the server. */
class ReadingPreferences(context: Context) {
    val data = context.getSharedPreferences("mailai.reading", Context.MODE_PRIVATE)
    var theme: String
        get() = data.getString("theme", "system").orEmpty()
        set(value) {
            require(value in listOf("system", "light", "dark"))
            data.edit().putString("theme", value).apply()
        }

    var bodySize: Int
        get() = data.getInt("bodySize", 16).coerceIn(14, 20)
        set(value) {
            require(value in listOf(14, 16, 18, 20))
            data.edit().putInt("bodySize", value).apply()
        }

    fun signature(accountId: String) = data.getString("signature.$accountId", "").orEmpty()

    fun signature(accountId: String, value: String) {
        data.edit().putString("signature.$accountId", value).apply()
    }

    fun stars(accountId: String): Set<String> =
        data.getStringSet("stars.$accountId", emptySet()).orEmpty().toSet()

    fun star(accountId: String, key: String, value: Boolean) =
        synchronized(starLock) {
            val next =
                stars(accountId).toMutableSet().apply { if (value) add(key) else remove(key) }
            check(data.edit().putStringSet("stars.$accountId", next).commit()) { "无法保存星标，请稍后重试" }
        }

    companion object {
        private val starLock = Any()
    }
}
