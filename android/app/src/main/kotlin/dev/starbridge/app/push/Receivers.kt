package dev.starbridge.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.starbridge.app.data.ApiException
import dev.starbridge.app.di.app
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** A notification button: signs and sends the answer, the screen locked or not. */
class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val choice = intent.getStringExtra(EXTRA_CHOICE)
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(EXTRA_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        if (choice == null && text == null) return
        val app = context.app()
        val pending = goAsync()
        app.scope().launch {
            val decision = app.store().decisions.value.find { it.id == id }
            try {
                withTimeout(9_000) { app.store().sendFromNotification(id, choice, text) }
                decision?.let { app.notifier().answered(it, choice ?: text!!) }
            } catch (e: Exception) {
                Log.w("Starbridge", "answer from notification failed", e)
                val why = when {
                    e is ApiException && e.error == "already-answered" -> "already answered elsewhere"
                    else -> e.message ?: "no connection"
                }
                if (e is ApiException && e.error == "already-answered") app.notifier().cancel(id)
                else decision?.let { app.notifier().failed(it, why) }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION = "dev.starbridge.app.ANSWER"
        const val EXTRA_ID = "id"
        const val EXTRA_CHOICE = "choice"
        const val EXTRA_TEXT = "text"
    }
}

/**
 * A prompt notification's button. Allow buttons require the unlock (the system asks before it
 * delivers them); Deny does not.
 */
class PromptReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val allow = intent.getBooleanExtra(EXTRA_ALLOW, false)
        val scope = intent.getStringExtra(EXTRA_SCOPE) ?: "once"
        val app = context.app()
        val pending = goAsync()
        app.scope().launch {
            val prompt = app.store().prompts.value.find { it.id == id }
            try {
                withTimeout(9_000) { app.store().sendPromptFromNotification(id, allow, scope) }
                prompt?.let { app.notifier().promptAnswered(it, if (allow) "Allowed" else "Denied") }
            } catch (e: Exception) {
                Log.w("Starbridge", "prompt answer from notification failed", e)
                val gone = e is ApiException && (e.error == "already-answered" || e.error == "expired")
                if (gone) prompt?.let { app.notifier().cancelPrompt(it) }
                else prompt?.let { app.notifier().promptFailed(it, e.message ?: "no connection") }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION = "dev.starbridge.app.PROMPT"
        const val EXTRA_ID = "id"
        const val EXTRA_ALLOW = "allow"
        const val EXTRA_SCOPE = "scope"
    }
}

/** FCM: the payload is data field `p` (PROTOCOL.md, "Push"). */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val p = message.data["p"] ?: return
        // This runs on FCM's own worker thread, which allows about 20 seconds.
        runBlocking {
            runCatching { withTimeout(15_000) { app().store().onPush(p) } }
                .onFailure { Log.w("Starbridge", "push failed", it) }
        }
    }

    override fun onNewToken(token: String) {
        val app = app()
        app.scope().launch { runCatching { app.store().subscribe("fcm", token, null) } }
    }
}

/** UnifiedPush, for self-hosters without Google: RFC 8291, decrypted by the connector. */
class UnifiedPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val app = app()
        val keys = endpoint.pubKeySet?.let { it.pubKey to it.auth }
        app.scope().launch {
            runCatching { app.store().subscribe("unifiedpush", endpoint.url, keys) }
                .onFailure { Log.w("Starbridge", "UnifiedPush subscribe failed", it) }
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) return
        val app = app()
        val p = message.content.decodeToString()
        app.scope().launch {
            runCatching { withTimeout(15_000) { app.store().onPush(p) } }
                .onFailure { Log.w("Starbridge", "push failed", it) }
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w("Starbridge", "UnifiedPush registration failed: $reason")
    }

    override fun onUnregistered(instance: String) = Unit
}
