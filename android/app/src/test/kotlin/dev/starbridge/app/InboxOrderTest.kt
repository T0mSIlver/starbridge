package dev.starbridge.app

import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Source
import dev.starbridge.app.ui.inbox.openQuestions
import dev.starbridge.app.ui.inbox.shownPrompts
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

// SPEC, Clients: prompts, then questions whose agent waits, then the rest, each oldest first, as on the web.
class InboxOrderTest {
    private val t0 = Instant.parse("2026-10-05T10:00:00Z")
    private val now = t0.plusSeconds(60)
    private val source = Source("devbox", "p", "s")

    private fun question(id: String, at: Long, waiting: Boolean = false) =
        Decision(id, id, "", emptyList(), null, source, t0.plusSeconds(at), waiting = waiting)

    private fun prompt(id: String, at: Long) =
        Prompt(id, "Bash", id, null, "{}", emptyList(), source, t0.plusSeconds(at), now.plusSeconds(600))

    @Test
    fun questionsWaitingFirstThenEachOldestFirst() {
        val decisions = listOf(question("infra3", 20), question("infra1", 0), question("waits", 30, waiting = true), question("infra2", 10))
        assertEquals(listOf("waits", "infra1", "infra2", "infra3"), openQuestions(decisions).map { it.id })
    }

    @Test
    fun promptsOldestFirst() {
        assertEquals(listOf("a", "b"), shownPrompts(listOf(prompt("b", 5), prompt("a", 0)), now).map { it.id })
    }
}
