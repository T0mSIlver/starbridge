package dev.starbridge.app.data

/**
 * Not thread-safe: the caller runs every call on one lock.
 *
 * Presence (#848): while the app is in front and was touched in the last minute, the owner is
 * using this phone, so the server holds the other devices' pushes. Only that bit reaches the
 * server, never what was touched. The timings are packages/protocol's (`presence.ts`).
 */
class Beacon(
    private val send: suspend (Boolean) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var lastInput = Long.MIN_VALUE / 2
    private var sent: Pair<Boolean, Long>? = null

    fun present(inFront: Boolean): Boolean = inFront && now() - lastInput < INPUT_MS

    /** A touch; returns whether it made the phone present, so the caller ticks at once. */
    fun input(inFront: Boolean): Boolean {
        val was = present(inFront)
        lastInput = now()
        return !was && present(inFront)
    }

    /** Says present when it is, again once a beat passed, and absent once it is not. */
    suspend fun tick(inFront: Boolean) {
        val present = present(inFront)
        val at = now()
        val last = sent
        if (present && (last?.first != true || at - last.second >= BEAT_MS)) {
            // A failed beat is tried again a beat later, not at every check: a server without
            // the route refuses it every time.
            sent = true to at
            runCatching { send(true) }
        } else if (!present && last?.first == true) {
            sent = false to at
            runCatching { send(false) }
        }
    }

    companion object {
        const val INPUT_MS = 60_000L
        const val BEAT_MS = 30_000L
        /** How often the app checks whether it still counts. */
        const val CHECK_MS = 10_000L
        /** The hold times offered, in seconds; 0 pushes at once. */
        val HOLD_CHOICES = listOf(0, 15, 30, 60, 120)
    }
}
