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
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.data.bitmap
import dev.starbridge.app.data.place
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.QuotaNotice
import dev.starbridge.app.data.Run
import dev.starbridge.app.protocol.RUN_STALE_MS
import dev.starbridge.app.ui.elapsed
import java.time.Duration
import java.time.Instant

/**
 * One notification per open decision. Its buttons are the options, the recommended one first,
 * and answer through [AnswerReceiver] without opening the app, from the lock screen too. A
 * decision without options gets a reply field instead.
 *
 * One notification per run: ongoing while it runs (a Live Update on Android 16 and later), then
 * pass or fail.
 */
class Notifier(private val context: Context, private val prefs: Prefs) : Alerts {
    private val manager = NotificationManagerCompat.from(context)

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Decisions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Questions your agents need you to answer"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(PROMPTS, "Permission prompts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Agents waiting for you to allow a command or an edit"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(JOIN_CHANNEL, "Join requests", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A browser or phone signed in to your account asks to join"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(RUNS, "Runs", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Commands your agents run that your rules name, until they pass or fail"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(QUOTAS, "Quotas", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Quota windows running low, running out, or resetting with headroom unused, for the providers you pick"
            },
        )
    }

    /** Quiet: one per window and kind, replaced by the next, and only for providers this phone picked. */
    override fun quota(notices: List<QuotaNotice>) {
        if (!allowed()) return
        val settings = prefs.quota.value
        for (n in notices) {
            if (!settings.wants(n) || !prefs.firstShow(n.key)) continue
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            @Suppress("MissingPermission")
            manager.notify(
                "q:${n.provider}/${n.window}/${n.kind}",
                0,
                NotificationCompat.Builder(context, QUOTAS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(accent())
                    .setContentTitle(n.title)
                    .setContentText(n.text)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }

    // POST_NOTIFICATIONS exists from Android 13; before that the app's notification setting rules.
    private fun allowed() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    } else {
        manager.areNotificationsEnabled()
    }

    private fun tag(id: String) = id.hashCode()

    /**
     * The icon's circle and the action labels: amber, or the wallpaper's primary under "Match
     * wallpaper". Android 12 to 15 show it; 16 tints them itself.
     */
    private fun accent() = context.getColor(if (prefs.colours.value == Colours.Wallpaper) R.color.accent_wallpaper else R.color.accent)

    private fun base(d: Decision): NotificationCompat.Builder {
        val open = PendingIntent.getActivity(
            context,
            tag(d.id),
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_DECISION, d.id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(accent())
            .setContentTitle(d.question)
            .setContentText(d.context)
            .setSubText(d.source.machine)
            .setStyle(style(d))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(accent())
                    .setContentTitle("A decision needs you")
                    .setSubText(d.source.machine)
                    .build(),
            )
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
    }

    /**
     * The first image as the big picture, with the context beneath it, when the decision has
     * one; else the context in full and the default.
     */
    private fun style(d: Decision): NotificationCompat.Style {
        val picture = d.images.firstOrNull()?.bitmap(PICTURE_EDGE)
            ?: return NotificationCompat.BigTextStyle().bigText(d.context + (d.default?.let { "\n\nIf nobody answers: $it" } ?: ""))
        return NotificationCompat.BigPictureStyle().bigPicture(picture).setSummaryText(d.context)
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
        val page = decision.answerIn
        if (page != null) {
            // Answered on that page, never here: the one button opens it. A claude.ai link goes to
            // the Claude app when that app claims it, else the browser.
            val view = PendingIntent.getActivity(
                context,
                tag(decision.id),
                Intent(Intent.ACTION_VIEW, Uri.parse(page.url)),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            b.addAction(NotificationCompat.Action.Builder(0, "Answer in ${page.place()}", view).build())
        } else if (decision.options.isEmpty()) {
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

    // --- Permission prompts ------------------------------------------------------

    /** One notification per session, updated in place: the prompt it shows now. */
    private val shown = java.util.Collections.synchronizedMap(mutableMapOf<Int, String>())

    private fun promptTag(p: Prompt) = "p:${p.source.machine}/${p.source.session}".hashCode()

    private fun promptIntent(p: Prompt, allow: Boolean, scope: String, request: Int): PendingIntent = PendingIntent.getBroadcast(
        context,
        request,
        Intent(context, PromptReceiver::class.java)
            .setAction(PromptReceiver.ACTION)
            .setData(Uri.Builder().scheme("starbridge-prompt").authority(if (allow) "allow" else "deny").appendPath(p.id).appendPath(scope).build())
            .putExtra(PromptReceiver.EXTRA_ID, p.id)
            .putExtra(PromptReceiver.EXTRA_ALLOW, allow)
            .putExtra(PromptReceiver.EXTRA_SCOPE, scope),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun promptBase(p: Prompt): NotificationCompat.Builder {
        val title = "${p.tool} on ${p.source.machine}"
        val open = PendingIntent.getActivity(
            context,
            promptTag(p),
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, PROMPTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(accent())
            .setContentTitle(title)
            .setContentText(p.summary)
            .setSubText(p.source.project)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOfNotNull(p.summary, p.description).joinToString("\n\n")))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // The lock screen shows only the tool and the machine, never the command.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, PROMPTS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(accent())
                    .setContentTitle(title)
                    .build(),
            )
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(maxOf(1_000L, p.expiresAt.toEpochMilli() - System.currentTimeMillis()))
    }

    /**
     * Deny works from the lock screen; both allows ask for the unlock first (the owner's choice,
     * SPEC.md). "Always" needs the app, which shows the exact rule.
     */
    override fun prompt(prompt: Prompt) = postPrompt(prompt, null)

    private fun postPrompt(prompt: Prompt, note: String?) {
        if (!allowed()) return
        val tag = promptTag(prompt)
        val b = promptBase(prompt)
        if (note != null) b.setContentText(note).setStyle(NotificationCompat.BigTextStyle().bigText(note)).setSilent(true)
        b.addAction(
            NotificationCompat.Action.Builder(0, "Allow once", promptIntent(prompt, true, "once", tag * 31))
                .setAuthenticationRequired(true)
                .build(),
        )
        if (prompt.scopes.any { it.scope == "session" }) {
            b.addAction(
                NotificationCompat.Action.Builder(0, "Allow for session", promptIntent(prompt, true, "session", tag * 31 + 1))
                    .setAuthenticationRequired(true)
                    .build(),
            )
        }
        b.addAction(
            NotificationCompat.Action.Builder(0, "Deny", promptIntent(prompt, false, "once", tag * 31 + 2))
                .setAuthenticationRequired(false)
                .build(),
        )
        shown[tag] = prompt.id
        @Suppress("MissingPermission")
        manager.notify(tag, b.build())
    }

    /** Says what was sent, then clears itself, unless a newer prompt of the session shows. */
    fun promptAnswered(prompt: Prompt, what: String) {
        if (!allowed()) return
        val tag = promptTag(prompt)
        synchronized(shown) {
            if (shown[tag] != null && shown[tag] != prompt.id) return
            shown[tag] = prompt.id
            @Suppress("MissingPermission")
            manager.notify(tag, promptBase(prompt).setContentText(what).setStyle(null).setTimeoutAfter(4_000).setSilent(true).build())
        }
    }

    fun promptFailed(prompt: Prompt, why: String) {
        synchronized(shown) {
            if (shown[promptTag(prompt)].let { it != null && it != prompt.id }) return
            postPrompt(prompt, "Not sent: $why")
        }
    }

    /** Clears the session's notification if it still shows this prompt. */
    override fun cancelPrompt(prompt: Prompt) {
        val tag = promptTag(prompt)
        // Store runs and notification buttons call in from different threads.
        synchronized(shown) {
            if (shown[tag] != null && shown[tag] != prompt.id) return
            shown.remove(tag)
            manager.cancel(tag)
        }
    }

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

    /**
     * Running: ongoing and silent, the time elapsed as a chronometer from the start, the progress
     * as a bar and in the status bar chip. It times out when the machine goes quiet past
     * RUN_STALE_MS. Ended: pass or fail with the duration, and it alerts once. Runs that ended
     * more than [Run.SHOWN_AFTER] ago, or lost their machine, show nothing.
     */
    override fun run(run: Run) {
        if (!allowed()) return
        val now = Instant.now()
        val state = run.state(now)
        if (Run.shown(listOf(run), now).isEmpty() || state == Run.State.Lost) {
            manager.cancel(RUNS, tag(run.id))
            return
        }
        val open = PendingIntent.getActivity(
            context,
            tag(run.id),
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = NotificationCompat.Builder(context, RUNS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(run.title)
            .setSubText(run.source.machine)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, RUNS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("A run on ${run.source.machine}")
                    .build(),
            )
        if (state == Run.State.Running) {
            val p = run.progress
            b.setContentText(listOfNotNull(p?.text, run.reason).joinToString(" · "))
                .setOngoing(true)
                .setRequestPromotedOngoing(true)
                .setShowWhen(true)
                .setWhen(run.startedAt.toEpochMilli())
                .setUsesChronometer(true)
                .setProgress(p?.total ?: 0, p?.done ?: 0, p == null)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter((RUN_STALE_MS - Duration.between(run.at, now).toMillis()).coerceAtLeast(1_000))
            p?.let { b.setShortCriticalText(it.text) }
        } else {
            val took = elapsed(run.startedAt, run.endedAt ?: run.at)
            val outcome = if (state == Run.State.Passed) "Passed in $took" else "Failed, exit ${run.exitCode}, after $took"
            b.setContentText(outcome)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$outcome\n${run.reason}"))
                .setShowWhen(true)
                .setWhen((run.endedAt ?: run.at).toEpochMilli())
                .setAutoCancel(true)
        }
        @Suppress("MissingPermission")
        manager.notify(RUNS, tag(run.id), b.build())
    }

    companion object {
        const val CHANNEL = "decisions"
        const val PROMPTS = "prompts"
        const val JOIN_CHANNEL = "joins"
        const val RUNS = "runs"
        const val QUOTAS = "quotas"

        /** Wide enough for an expanded notification on any phone, small enough for its bitmap limit. */
        private const val PICTURE_EDGE = 1024
    }
}
