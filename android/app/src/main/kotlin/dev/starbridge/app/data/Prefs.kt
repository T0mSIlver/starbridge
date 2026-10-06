package dev.starbridge.app.data

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/** The "Colours" setting (DESIGN.md, "The look"): DESIGN.md's palette, or Material You from the wallpaper. */
enum class Colours { Starbridge, Wallpaper }

/**
 * How the inbox shows, remembered on this phone: one feed, grouped by machine or by waiting,
 * History open or closed, when question cards carry their answer buttons (#138), and whether it
 * says so while notifications are off (#342).
 */
data class InboxView(
    val grouping: Grouping = Grouping.None,
    val historyOpen: Boolean = false,
    val buttons: CardButtons = CardButtons.Always,
    val remindOff: Boolean = true,
)

/** The inbox's groups: none, one per machine, or what blocks an agent above what can wait (#191). */
enum class Grouping { None, Machine, Waiting }

/** When a question's card carries its answer buttons; tapping the card opens the question either way. */
enum class CardButtons { Always, WhenWaiting, Never }

/** The "Clock" setting: the phone's 12- or 24-hour choice, or one of them. */
enum class Clock { System, H12, H24 }

/** Display settings: nothing secret, so plain preferences rather than the [Vault]. */
@Singleton
class Prefs @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = context.getSharedPreferences("display", Context.MODE_PRIVATE)

    private val _colours = MutableStateFlow(
        Colours.entries.find { it.name == prefs.getString(COLOURS, null) } ?: Colours.Starbridge,
    )
    val colours: StateFlow<Colours> = _colours

    fun setColours(value: Colours) {
        prefs.edit().putString(COLOURS, value.name).apply()
        _colours.value = value
    }

    private val _clock = MutableStateFlow(Clock.entries.find { it.name == prefs.getString(CLOCK, null) } ?: Clock.System)
    val clock: StateFlow<Clock> = _clock

    fun setClock(value: Clock) {
        prefs.edit().putString(CLOCK, value.name).apply()
        _clock.value = value
    }

    private val _quota = MutableStateFlow(
        prefs.getString(QUOTA, null)?.let { runCatching { json.decodeFromString(QuotaSettings.serializer(), it) }.getOrNull() } ?: QuotaSettings(),
    )
    val quota: StateFlow<QuotaSettings> = _quota

    fun setQuota(value: QuotaSettings) {
        prefs.edit().putString(QUOTA, json.encodeToString(QuotaSettings.serializer(), value)).apply()
        _quota.value = value
    }

    private val _inbox = MutableStateFlow(
        InboxView(
            // "Group by machine" was a switch before grouping by waiting; it carries over.
            Grouping.entries.find { it.name == prefs.getString(GROUPING, null) }
                ?: if (prefs.getBoolean(BY_MACHINE, false)) Grouping.Machine else Grouping.None,
            prefs.getBoolean(HISTORY_OPEN, false),
            CardButtons.entries.find { it.name == prefs.getString(BUTTONS, null) } ?: CardButtons.Always,
            prefs.getBoolean(REMIND_OFF, true),
        ),
    )
    val inbox: StateFlow<InboxView> = _inbox

    fun setInbox(value: InboxView) {
        prefs.edit().putString(GROUPING, value.grouping.name).remove(BY_MACHINE).putBoolean(HISTORY_OPEN, value.historyOpen).putString(BUTTONS, value.buttons.name).putBoolean(REMIND_OFF, value.remindOff).apply()
        _inbox.value = value
    }

    private val _allowUnseen = MutableStateFlow(prefs.getBoolean(ALLOW_UNSEEN, false))

    /** A notification's Allow sends even when the whole command was not on screen; off by default (#390). */
    val allowUnseen: StateFlow<Boolean> = _allowUnseen

    fun setAllowUnseen(value: Boolean) {
        prefs.edit().putBoolean(ALLOW_UNSEEN, value).apply()
        _allowUnseen.value = value
    }

    /** Marks a quota notice shown; false when it already was. Keeps the last 200. */
    @Synchronized
    fun firstShow(key: String): Boolean {
        val shown = prefs.getString(QUOTA_SHOWN, null)?.split('\n')?.filter { it.isNotEmpty() }.orEmpty()
        if (key in shown) return false
        prefs.edit().putString(QUOTA_SHOWN, (shown + key).takeLast(200).joinToString("\n")).apply()
        return true
    }

    private companion object {
        const val COLOURS = "colours"
        const val CLOCK = "clock"
        const val QUOTA = "quota"
        const val QUOTA_SHOWN = "quota-shown"
        const val BY_MACHINE = "inbox-by-machine"
        const val GROUPING = "inbox-grouping"
        const val HISTORY_OPEN = "inbox-history-open"
        const val BUTTONS = "inbox-card-buttons"
        const val ALLOW_UNSEEN = "allow-unseen"
        const val REMIND_OFF = "inbox-remind-notifications-off"
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
    }
}
