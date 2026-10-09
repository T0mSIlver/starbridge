package dev.starbridge.app

import dev.starbridge.app.ui.inbox.closedHow
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

// History says who closed a question in the web's words (#738): the agent withdraws, nobody "on" it.
class ClosedByTest {
    private val asked = Fake(Instant.parse("2026-10-07T10:00:00Z")).screenshot

    @Test
    fun whatThenWho() {
        assertEquals("Looks right · on this phone", closedHow(asked.copy(answer = "Looks right")))
        assertEquals("Looks right · on Pixel", closedHow(asked.copy(theirAnswer = "Looks right", answeredOn = "Pixel")))
        assertEquals("Answered · at the keyboard", closedHow(asked.copy(settled = "elsewhere")))
        assertEquals("Withdrawn · by the agent", closedHow(asked.copy(settled = "withdrawn")))
        assertEquals("Answered · on another device", closedHow(asked.copy(answeredAt = Instant.parse("2026-10-07T10:05:00Z"))))
    }
}
