package dev.starbridge.app.ui

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.starbridge.app.push.notificationsAllowed

/** Whether this phone shows Starbridge's notifications, read again each time the app comes back (#342). */
@Composable
fun rememberNotificationsOn(): Boolean {
    val context = LocalContext.current
    var on by remember { mutableStateOf(notificationsAllowed(context)) }
    LifecycleResumeEffect(context) {
        on = notificationsAllowed(context)
        onPauseOrDispose {}
    }
    return on
}

/**
 * Android's notification settings for this app. Turning them on there also grants Android 13's
 * permission, which the first-run prompt can no longer ask for once refused twice.
 */
fun openNotificationSettings(context: Context) {
    runCatching {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
    }
}
