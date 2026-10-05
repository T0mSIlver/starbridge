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

/** How the inbox shows, remembered on this phone: one feed or grouped by machine, and History open or closed. */
data class InboxView(val byMachine: Boolean = false, val historyOpen: Boolean = false)

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

    private val _quota = MutableStateFlow(
        prefs.getString(QUOTA, null)?.let { runCatching { json.decodeFromString(QuotaSettings.serializer(), it) }.getOrNull() } ?: QuotaSettings(),
    )
    val quota: StateFlow<QuotaSettings> = _quota

    fun setQuota(value: QuotaSettings) {
        prefs.edit().putString(QUOTA, json.encodeToString(QuotaSettings.serializer(), value)).apply()
        _quota.value = value
    }

    private val _inbox = MutableStateFlow(InboxView(prefs.getBoolean(BY_MACHINE, false), prefs.getBoolean(HISTORY_OPEN, false)))
    val inbox: StateFlow<InboxView> = _inbox

    fun setInbox(value: InboxView) {
        prefs.edit().putBoolean(BY_MACHINE, value.byMachine).putBoolean(HISTORY_OPEN, value.historyOpen).apply()
        _inbox.value = value
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
        const val QUOTA = "quota"
        const val QUOTA_SHOWN = "quota-shown"
        const val BY_MACHINE = "inbox-by-machine"
        const val HISTORY_OPEN = "inbox-history-open"
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
    }
}
