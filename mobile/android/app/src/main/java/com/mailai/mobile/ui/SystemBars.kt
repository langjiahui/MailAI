package com.mailai.mobile.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

/** Keep in-app appearance and Android's status/navigation controls in agreement. */
@Composable
internal fun MailSystemBars() {
    val view = LocalView.current
    val background = MaterialTheme.colorScheme.background.toArgb()
    val dark = MaterialTheme.colorScheme.background.luminance() < .4f
    DisposableEffect(view, dark, background) {
        val dialog = (view.parent as? DialogWindowProvider)?.window
        val activity = view.context.activity()
        val style =
            if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
            else
                SystemBarStyle.light(
                    android.graphics.Color.TRANSPARENT,
                    android.graphics.Color.TRANSPARENT,
                )
        if (dialog == null) (activity as? ComponentActivity)?.enableEdgeToEdge(style, style)
        val window = dialog ?: activity?.window
        if (window != null) {
            window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(background))
            window.decorView.setBackgroundColor(background)
            window.isNavigationBarContrastEnforced = false
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
        onDispose {}
    }
}

private fun Context.activity(): Activity? {
    var current = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
