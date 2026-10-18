package com.mailai.mobile

import android.app.Application
import com.mailai.mobile.background.MailNotifications
import com.mailai.mobile.data.MailRepository
import com.mailai.mobile.update.AppUpdates

class MailApplication : Application() {
    val repository by lazy { MailRepository(this) }
    val updates by lazy { AppUpdates(this) }

    override fun onCreate() {
        super.onCreate()
        MailNotifications.channels(this)
    }
}
