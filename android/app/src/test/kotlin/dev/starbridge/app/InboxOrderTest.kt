package dev.starbridge.app

import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Source
import dev.starbridge.app.ui.inbox.needYou
import dev.starbridge.app.ui.inbox.openQuestions
import dev.starbridge.app.ui.inbox.shownPrompts
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

// spec/clients.md: prompts, then questions whose agent waits, then the rest, each oldest first, as on the web.
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
    fun oneCallsQuestionsInTheCallsOrder() {
        // #1079: the CLI stamps them a millisecond apart.
        val decisions = (0L..3L).reversed().map { Decision("q$it", "q$it", "", emptyList(), null, source, t0.plusMillis(it)) }
        assertEquals(listOf("q0", "q1", "q2", "q3"), openQuestions(decisions).map { it.id })
    }

    @Test
    fun promptsOldestFirst() {
        assertEquals(listOf("a", "b"), shownPrompts(listOf(prompt("b", 5), prompt("a", 0)), now).map { it.id })
    }

    // #1963: the Inbox tab badge is the app icon's count, as on web and iOS.
    @Test
    fun needYouCountsWaitingPromptsAndOpenQuestionsButNotSnoozedOrEnded() {
        val questions = (1..4).map { question("q$it", it.toLong()) }
        val snoozed = question("zz", 9).copy(snoozedUntil = now.plusSeconds(3600))
        val ended = prompt("ended", 3).copy(ended = "Allowed once", endedAt = now.minusSeconds(5))
        assertEquals(5, needYou(questions + snoozed, listOf(prompt("p", 0), ended), now))
    }
}
