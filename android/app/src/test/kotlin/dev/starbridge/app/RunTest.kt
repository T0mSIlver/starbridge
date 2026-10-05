package dev.starbridge.app

import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Source
import dev.starbridge.app.ui.elapsed
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class RunTest {
    private val t0 = Instant.parse("2026-10-05T10:00:00Z")
    private fun run(id: String, startedAt: Instant = t0, at: Instant = t0, exit: Int? = null, endedAt: Instant? = null) =
        Run(id, id, "reason", Source("devbox", "p", "s"), startedAt, at, exitCode = exit, endedAt = endedAt)

    @Test
    fun stateFollowsTheExitAndTheMachinesSilence() {
        assertEquals(Run.State.Running, run("a").state(t0.plusSeconds(60)))
        assertEquals(Run.State.Lost, run("a").state(t0.plusSeconds(181)))
        assertEquals(Run.State.Passed, run("a", exit = 0, endedAt = t0).state(t0.plusSeconds(999)))
        assertEquals(Run.State.Failed, run("a", exit = 3, endedAt = t0).state(t0))
    }

    @Test
    fun runningComesFirstAndFinishedRunsStayHalfAnHour() {
        val now = t0.plusSeconds(60)
        val runs = listOf(
            run("old", exit = 0, endedAt = now.minus(Run.SHOWN_AFTER)),
            run("gone", exit = 0, endedAt = now.minus(Run.SHOWN_AFTER).minusSeconds(1)),
            run("fail", exit = 1, endedAt = t0.plusSeconds(30)),
            run("early", startedAt = t0.minusSeconds(10), at = t0.plusSeconds(50)),
            run("late", startedAt = t0.plusSeconds(10), at = t0.plusSeconds(50)),
        )
        assertEquals(listOf("late", "early", "fail", "old"), Run.shown(runs, now).map { it.id })
    }

    @Test
    fun elapsedReadsAtAGlance() {
        assertEquals("8 s", elapsed(t0, t0.plusMillis(8_400)))
        assertEquals("2 min 05 s", elapsed(t0, t0.plusSeconds(125)))
        assertEquals("1 h 03 min", elapsed(t0, t0.plusSeconds(3_780)))
        assertEquals("3/7", Run.Progress(3, 7, percent = false).text)
        assertEquals("42%", Run.Progress(42, 100, percent = true).text)
    }
}
