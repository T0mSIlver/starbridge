package dev.starbridge.app.push

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.ServerStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Keeps one push route registered while the phone is set up: FCM by default, UnifiedPush when
 * the owner picks it (a distributor app such as ntfy must be installed).
 */
class Pusher(private val context: Context, private val store: ServerStore, private val scope: CoroutineScope) {
    fun start() {
        scope.launch {
            combine(store.phase, store.push) { phase, push -> (phase == Phase.Ready) to push.type }
                .distinctUntilChanged()
                .collect { (ready, type) ->
                    store.setDistributors(UnifiedPush.getDistributors(context))
                    if (!ready) return@collect
                    if (type == "unifiedpush") useUnifiedPush() else useFcm()
                }
        }
        // A route that failed to register while offline is tried again once a network is back.
        context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { store.retryPush() }
            }
        })
    }

    private fun useFcm() {
        runCatching { UnifiedPush.unregister(context) }
        if (FirebaseApp.getApps(context).isEmpty()) {
            store.say("This build has no Firebase project, so Google push is off. In Settings, set \"Delivered through\" to UnifiedPush.")
            return
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w("Starbridge", "FCM token failed", task.exception)
                store.say("Google push is not available on this phone. In Settings, set \"Delivered through\" to UnifiedPush.")
                return@addOnCompleteListener
            }
            scope.launch {
                runCatching { store.subscribe("fcm", task.result, null) }.onFailure { Log.w("Starbridge", "FCM subscribe failed", it) }
            }
        }
    }

    private fun useUnifiedPush() {
        UnifiedPush.tryUseCurrentOrDefaultDistributor(context) { ok ->
            if (ok) UnifiedPush.register(context) else store.say("No UnifiedPush distributor on this phone. Install one, such as ntfy.")
        }
    }
}
