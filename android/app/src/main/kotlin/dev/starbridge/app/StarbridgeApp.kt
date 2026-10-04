package dev.starbridge.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp
import dev.starbridge.app.push.Pusher
import javax.inject.Inject

@HiltAndroidApp
class StarbridgeApp : Application() {
    @Inject lateinit var pusher: Pusher

    override fun onCreate() {
        super.onCreate()
        pusher.start()
    }
}
