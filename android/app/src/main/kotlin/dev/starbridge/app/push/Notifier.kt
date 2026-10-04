package dev.starbridge.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import dev.starbridge.app.MainActivity
import dev.starbridge.app.R
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision

/**
 * One notification per open decision. Its buttons are the options, the recommended one first,
 * and answer through [AnswerReceiver] without opening the app, from the lock screen too. A
 * decision without options gets a reply field instead.
 */
class Notifier(private val context: Context) : Alerts {
    private val manager = NotificationManagerCompat.from(context)

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Questions your agents need you to answer"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(JOIN_CHANNEL, "Join requests", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A browser or phone signed in to your account asks to join"
            },
        )
    }

    // POST_NOTIFICATIONS exists from Android 13; before that the app's notification setting rules.
    private fun allowed() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    } else {
        manager.areNotificationsEnabled()
    }

    private fun tag(id: String) = id.hashCode()

    private fun base(d: Decision): NotificationCompat.Builder {
        val open = PendingIntent.getActivity(
            context,
            tag(d.id),
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_DECISION, d.id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(d.question)
            .setContentText(d.context)
            .setSubText(d.source.machine)
            .setStyle(NotificationCompat.BigTextStyle().bigText(d.context + "\n\nIf nobody answers: " + d.default))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("A decision needs you")
                    .setSubText(d.source.machine)
                    .build(),
            )
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
    }

    /**
     * Each button's intent carries its decision and option in its data, so no two buttons share a
     * PendingIntent: the system matches them by action and data, not extras.
     */
    private fun answerIntent(d: Decision, choice: String?, request: Int, mutable: Boolean): PendingIntent = PendingIntent.getBroadcast(
        context,
        request,
        Intent(context, AnswerReceiver::class.java)
            .setAction(AnswerReceiver.ACTION)
            .setData(Uri.Builder().scheme("starbridge-answer").authority("decision").appendPath(d.id).appendPath(choice ?: "").build())
            .putExtra(AnswerReceiver.EXTRA_ID, d.id)
            .putExtra(AnswerReceiver.EXTRA_CHOICE, choice),
        PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE,
    )

    override fun decision(decision: Decision) = post(decision, null)

    private fun post(decision: Decision, note: String?) {
        if (!allowed()) return
        val b = base(decision)
        if (note != null) b.setContentText(note).setStyle(NotificationCompat.BigTextStyle().bigText(note)).setSilent(true)
        if (decision.options.isEmpty()) {
            val input = RemoteInput.Builder(AnswerReceiver.EXTRA_TEXT).setLabel("Your answer").build()
            b.addAction(
                NotificationCompat.Action.Builder(0, "Answer", answerIntent(decision, null, tag(decision.id), mutable = true))
                    .addRemoteInput(input)
                    .setAllowGeneratedReplies(false)
                    .setAuthenticationRequired(false)
                    .build(),
            )
        } else {
            // Android shows three buttons; the recommended option leads, the app holds the rest.
            decision.options.sortedByDescending { it == decision.recommended }.take(3).forEachIndexed { i, option ->
                b.addAction(
                    NotificationCompat.Action.Builder(0, option, answerIntent(decision, option, tag(decision.id) * 31 + i, mutable = false))
                        .setAuthenticationRequired(false)
                        .build(),
                )
            }
        }
        @Suppress("MissingPermission")
        manager.notify(tag(decision.id), b.build())
    }

    /** Replaces the buttons with the answer, then clears itself. */
    fun answered(decision: Decision, answer: String) {
        if (!allowed()) return
        @Suppress("MissingPermission")
        manager.notify(
            tag(decision.id),
            base(decision).setContentText("Answered: $answer").setStyle(null).setTimeoutAfter(4_000).setSilent(true).build(),
        )
    }

    /** Keeps the buttons and says why the answer did not go through. */
    fun failed(decision: Decision, why: String) = post(decision, "Not sent: $why")

    override fun cancel(id: String) = manager.cancel(tag(id))

    /** Tapping it opens the app, which shows the request to compare digits with. */
    override fun join(id: String, name: String) {
        if (!allowed()) return
        val open = PendingIntent.getActivity(
            context,
            tag(id),
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        @Suppress("MissingPermission")
        manager.notify(
            tag(id),
            NotificationCompat.Builder(context, JOIN_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("$name wants to join")
                .setContentText("Open Starbridge to compare digits and approve it.")
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setTimeoutAfter(10 * 60_000L)
                .build(),
        )
    }

    companion object {
        const val CHANNEL = "decisions"
        const val JOIN_CHANNEL = "joins"
    }
}
