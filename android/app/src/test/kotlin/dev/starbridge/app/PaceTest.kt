package dev.starbridge.app

import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.paceOf
import dev.starbridge.app.protocol.Pace as Wire
import org.junit.Assert.assertEquals
import org.junit.Test

class PaceTest {
    private fun wire(stage: String, lasts: Boolean = true, runsOut: String? = null) =
        Wire(stage, expectedUsedPercent = 43.0, deltaPercent = -21.0, projectedUsedPercent = 50.0, willLastToReset = lasts, runsOutAt = runsOut)

    @Test
    fun behindPaceWithoutAnAlertIsOnPace() {
        // Same snapshot as the web: only the uploader's unused-headroom alert turns a window amber.
        assertEquals(Pace.Even, paceOf(wire("behind"), unusedAlert = null))
    }

    @Test
    fun unusedHeadroomComesFromTheAlert() {
        assertEquals(Pace.Unused(86), paceOf(wire("behind"), unusedAlert = 85.6))
    }

    @Test
    fun runsOutWinsOverAnAlert() {
        val p = paceOf(wire("ahead", lasts = false, runsOut = "2026-10-05T12:00:00Z"), unusedAlert = 10.0)
        assertEquals(true, p is Pace.RunsOut)
    }

    @Test
    fun tooEarlyToTell() {
        assertEquals(Pace.Unknown, paceOf(wire("unknown", lasts = false), unusedAlert = null))
        assertEquals(Pace.Unknown, paceOf(null, unusedAlert = null))
    }
}
