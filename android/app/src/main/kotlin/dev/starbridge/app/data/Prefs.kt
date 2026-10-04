package dev.starbridge.app.data

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/** The "Colours" setting (DESIGN.md, "The look"): DESIGN.md's palette, or Material You from the wallpaper. */
enum class Colours { Starbridge, Wallpaper }

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

    private companion object {
        const val COLOURS = "colours"
    }
}
