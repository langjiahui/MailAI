package com.mailai.mobile.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Gesture bars follow the content; the OS-owned three-button strip follows the system theme. */
@Composable
internal fun MailSystemBars() {
    val view = LocalView.current
    val background = MaterialTheme.colorScheme.background.toArgb()
    val dark = MaterialTheme.colorScheme.background.luminance() < .4f
    val systemDark = isSystemInDarkTheme()
    DisposableEffect(view, dark, systemDark, background) {
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
        val overlayHost = window?.decorView ?: view
        val navigation = if (systemDark) 0xff131a17.toInt() else 0xfff3f8fb.toInt()
        val protection =
            object : Drawable() {
                val paint = Paint()

                override fun draw(canvas: Canvas) {
                    val bars =
                        ViewCompat.getRootWindowInsets(overlayHost)
                            ?.getInsets(WindowInsetsCompat.Type.tappableElement()) ?: return
                    paint.color = navigation
                    if (bars.bottom > 0)
                        canvas.drawRect(
                            0f,
                            (bounds.height() - bars.bottom).toFloat(),
                            bounds.width().toFloat(),
                            bounds.height().toFloat(),
                            paint,
                        )
                    if (bars.left > 0)
                        canvas.drawRect(
                            0f,
                            0f,
                            bars.left.toFloat(),
                            bounds.height().toFloat(),
                            paint,
                        )
                    if (bars.right > 0)
                        canvas.drawRect(
                            (bounds.width() - bars.right).toFloat(),
                            0f,
                            bounds.width().toFloat(),
                            bounds.height().toFloat(),
                            paint,
                        )
                }

                override fun setAlpha(alpha: Int) {}

                override fun setColorFilter(filter: ColorFilter?) {}

                @Deprecated("Deprecated in Android") override fun getOpacity() = PixelFormat.OPAQUE
            }
        window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(background))
        // The full-screen Compose Surface paints over Window.background, including the
        // inset area. Paint the native-button protection above that Surface instead.
        overlayHost.overlay.add(protection)
        window?.isNavigationBarContrastEnforced = false
        fun appearance() {
            if (window == null) return
            val bars =
                ViewCompat.getRootWindowInsets(overlayHost)
                    ?.getInsets(WindowInsetsCompat.Type.tappableElement())
            val buttons = bars != null && (bars.bottom > 0 || bars.left > 0 || bars.right > 0)
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !(if (buttons) systemDark else dark)
            }
            protection.setBounds(0, 0, overlayHost.width, overlayHost.height)
            protection.invalidateSelf()
        }
        appearance()
        val observer = view.viewTreeObserver
        val focus =
            android.view.ViewTreeObserver.OnWindowFocusChangeListener { focused ->
                if (focused) appearance()
            }
        val layout = android.view.ViewTreeObserver.OnGlobalLayoutListener { appearance() }
        observer.addOnWindowFocusChangeListener(focus)
        observer.addOnGlobalLayoutListener(layout)
        onDispose {
            overlayHost.overlay.remove(protection)
            if (observer.isAlive) {
                observer.removeOnWindowFocusChangeListener(focus)
                observer.removeOnGlobalLayoutListener(layout)
            }
        }
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
