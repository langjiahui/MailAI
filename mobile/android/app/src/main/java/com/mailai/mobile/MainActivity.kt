package com.mailai.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.FileProvider
import com.mailai.mobile.ui.MailScreen
import com.mailai.mobile.ui.MailViewModel

class MainActivity : ComponentActivity() {
    private val model: MailViewModel by viewModels()

    override fun onSaveInstanceState(outState: Bundle) {
        model.rememberLocation()
        super.onSaveInstanceState(outState)
    }

    override fun onStop() {
        if (!isChangingConfigurations) model.assistantBackground()
        model.onBackground()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        model.resumeCache()
        com.mailai.mobile.background.BackgroundSchedule.catchUp(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    private fun route(intent: Intent?) {
        if (intent?.action == "com.mailai.OPEN_BACKGROUND")
            model.openNotification(null, true, backgroundSettings = true)
        else if (intent?.action == "com.mailai.OPEN_UPDATES") model.openNotification(null, true)
        else if (intent?.action == "com.mailai.OPEN_MAIL")
            model.openNotification(
                intent.getStringExtra("accountId"),
                false,
                intent.getStringExtra("messageKey"),
            )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        com.mailai.mobile.background.BackgroundSchedule.configure(this)
        if (savedInstanceState == null) route(intent)
        setContent {
            MailScreen(model) { account, attachment, share ->
                val file = model.repo.file(account, attachment.local)
                val uri =
                    FileProvider.getUriForFile(
                        this,
                        "${BuildConfig.APPLICATION_ID}.files",
                        file,
                        attachment.name,
                    )
                val intent =
                    if (share)
                        Intent(Intent.ACTION_SEND).apply {
                            type = attachment.type
                            putExtra(Intent.EXTRA_STREAM, uri)
                        }
                    else Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.type)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                intent.clipData =
                    android.content.ClipData.newUri(contentResolver, attachment.name, uri)
                try {
                    startActivity(Intent.createChooser(intent, if (share) "分享附件" else "打开附件"))
                } catch (_: android.content.ActivityNotFoundException) {
                    android.widget.Toast.makeText(
                            this,
                            "没有可打开此文件的应用，请选择分享",
                            android.widget.Toast.LENGTH_LONG,
                        )
                        .show()
                }
            }
        }
    }
}
