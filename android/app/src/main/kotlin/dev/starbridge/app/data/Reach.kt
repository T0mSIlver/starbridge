package dev.starbridge.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Whether the server answers, said to the owner only once it has not for [QUIET_MS] (#920). A phone
 * that just woke, or whose VPN is reconnecting, fails its first calls for a few seconds while the
 * server is fine: those failures stay quiet, and the message goes as soon as a call gets through.
 */
class Reach(private val scope: CoroutineScope, private val now: () -> Long = System::currentTimeMillis) {
    private var online = true
    /** Since when the network has been down, or the server unanswered on a working one. */
    private var offlineSince: Long? = null
    private var failingSince: Long? = null
    private var timer: Job? = null

    enum class Status { Offline, Unreachable }

    /** Null while all is well, or while it has not lasted [QUIET_MS]. */
    val status = MutableStateFlow<Status?>(null)

    @Synchronized
    fun network(validated: Boolean) {
        if (validated == online) return
        online = validated
        offlineSince = if (validated) null else now()
        // The time unanswered counts from when the network came back.
        if (validated && failingSince != null) failingSince = now()
        check()
    }

    /** A call got no answer: the network or the server failed it. */
    @Synchronized
    fun failed() {
        if (failingSince == null) failingSince = now()
        check()
    }

    /** The server answered, whatever it said. */
    @Synchronized
    fun reached() {
        failingSince = null
        check()
    }

    /**
     * The app comes to the front: the time it spent behind, offline or not, counts for nothing, so
     * a phone unlocked a moment before its network is back says nothing.
     */
    @Synchronized
    fun resumed() {
        if (!online) offlineSince = now()
        failingSince = null
        check()
    }

    /** Says what is wrong now rather than after the quiet time: the owner asked, by a pull. */
    @Synchronized
    fun surface() {
        if (!online) offlineSince = now() - QUIET_MS
        else if (failingSince != null) failingSince = now() - QUIET_MS
        check()
    }

    @Synchronized
    private fun check() {
        val since = if (!online) offlineSince else failingSince
        val left = since?.let { it + QUIET_MS - now() }
        status.value = when {
            left == null || left > 0 -> null
            !online -> Status.Offline
            else -> Status.Unreachable
        }
        timer?.cancel()
        if (left != null && left > 0) timer = scope.launch {
            delay(left)
            check()
        }
    }

    companion object {
        const val QUIET_MS = 10_000L

        /** [status] in the owner's words, for the server at [host]; no exception text. */
        fun words(status: Status?, host: String): String? = when (status) {
            null -> null
            Status.Offline -> "Offline. Retrying when you're back online."
            Status.Unreachable -> "Can't reach $host. Retrying."
        }

        /** A failure that says nothing of the request, only that it did not get through. */
        fun transient(e: Throwable) = e is IOException && (e !is ApiException || e.status == 502 || e.status == 503 || e.status == 504)
    }
}

/** Whether the default network, a VPN included, has reached the internet, as Android checked it. */
fun validatedNetwork(context: Context): StateFlow<Boolean> {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    fun validated(caps: NetworkCapabilities?) = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    val flow = MutableStateFlow(validated(cm.getNetworkCapabilities(cm.activeNetwork)))
    cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            flow.value = validated(caps)
        }

        override fun onLost(network: Network) {
            flow.value = false
        }
    })
    return flow
}
