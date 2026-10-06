package dev.starbridge.app

import dev.starbridge.app.data.promptEnded
import dev.starbridge.app.protocol.Settled
import org.junit.Assert.assertEquals
import org.junit.Test

// History says how and where a prompt was answered, as the web does (#349).
class PromptEndedTest {
    private fun ended(answer: String? = null, settled: Settled? = null, answeredAt: String? = "2026-10-06T10:00:00Z") =
        promptEnded(answer, settled, answeredAt, "devbox", "d_me") { if (it == "d_pixel") "Pixel" else null }

    private fun byDevice(device: String, behavior: String? = null) =
        Settled(1, "st_1", "perm_1", listOf("d_me"), "2026-10-06T10:00:00Z", "device", device, behavior)

    @Test
    fun whatThenWhere() {
        assertEquals("Denied · on Pixel", ended(settled = byDevice("d_pixel", "deny")))
        assertEquals("Allowed · on this phone", ended(settled = byDevice("d_me", "allow")))
        assertEquals("Answered · on Pixel", ended(settled = byDevice("d_pixel")))
        assertEquals("Allowed for this session · on this phone", ended(answer = "allow:session"))
        assertEquals("Denied · on this phone", ended(answer = "deny"))
        assertEquals("Answered · on devbox", ended(settled = Settled(1, "st_1", "perm_1", listOf("d_me"), "2026-10-06T10:00:00Z", "keyboard")))
        assertEquals(null, ended(answeredAt = null))
    }
}
