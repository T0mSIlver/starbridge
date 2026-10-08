package dev.starbridge.app

import dev.starbridge.app.data.Beacon
import dev.starbridge.app.ui.settings.holdLabel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

// The app in front and touched in the last minute says so to the server, beats, and says absent once behind or idle (#848).
class PresenceTest {
    @Test
    fun saysPresentWhileUsedAndAbsentOnceBehindOrIdle() = runBlocking {
        var now = 0L
        val sent = mutableListOf<Boolean>()
        val b = Beacon({ sent += it }, { now })
        // In front alone is not enough: an app left open says nothing.
        b.tick(inFront = true)
        assertEquals(emptyList<Boolean>(), sent)
        if (b.input(inFront = true)) b.tick(inFront = true)
        assertEquals(listOf(true), sent)
        now = 10_000
        b.input(inFront = true)
        b.tick(inFront = true)
        assertEquals(listOf(true), sent)
        now = 30_000
        b.tick(inFront = true)
        assertEquals(listOf(true, true), sent)
        now = 70_001
        b.tick(inFront = true)
        assertEquals(listOf(true, true, false), sent)
        if (b.input(inFront = true)) b.tick(inFront = true)
        b.tick(inFront = false)
        assertEquals(listOf(true, true, false, true, false), sent)
    }

    @Test
    fun aFailedBeatIsTriedAgain() = runBlocking {
        var fail = true
        val sent = mutableListOf<Boolean>()
        val b = Beacon({ if (fail) error("offline") else sent += it }, { 0L })
        b.input(inFront = true)
        b.tick(inFront = true)
        fail = false
        b.tick(inFront = true)
        assertEquals(listOf(true), sent)
    }

    @Test
    fun holdTimesReadAsTheWebShowsThem() {
        assertEquals(listOf("Off", "15 s", "30 s", "1 min", "2 min"), Beacon.HOLD_CHOICES.map(::holdLabel))
    }
}
