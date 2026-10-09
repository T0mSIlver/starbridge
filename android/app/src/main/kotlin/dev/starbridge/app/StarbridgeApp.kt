package dev.starbridge.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.push.Pusher
import dev.starbridge.app.widget.watchWidgets
import kotlinx.coroutines.CoroutineScope
import javax.inject.Inject

@HiltAndroidApp
class StarbridgeApp : Application() {
    @Inject lateinit var pusher: Pusher
    @Inject lateinit var store: ServerStore
    @Inject lateinit var prefs: Prefs
    @Inject lateinit var scope: CoroutineScope

    override fun onCreate() {
        super.onCreate()
        pusher.start()
        watchWidgets(this, store, prefs, scope)
    }
}
