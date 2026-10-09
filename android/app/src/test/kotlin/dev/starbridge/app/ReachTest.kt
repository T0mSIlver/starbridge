package dev.starbridge.app

import dev.starbridge.app.data.ApiException
import dev.starbridge.app.data.Reach
import dev.starbridge.app.data.Reach.Status
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** A short outage says nothing; a long one says which, and the first answer clears it (#920). */
@OptIn(ExperimentalCoroutinesApi::class)
class ReachTest {
    private fun TestScope.reach() = Reach(backgroundScope) { testScheduler.currentTime }

    private fun TestScope.after(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    @Test
    fun unlockedBeforeTheNetworkIsBackSaysNothing() = runTest {
        val reach = reach()
        // Offline while the phone was locked, for far longer than the quiet time.
        reach.network(false)
        after(60_000)
        assertEquals(Status.Offline, reach.status.value)
        reach.resumed()
        assertNull(reach.status.value)
        after(2_000)
        reach.network(true)
        reach.reached()
        after(30_000)
        assertNull(reach.status.value)
    }

    @Test
    fun offlineInFrontSpeaksAfterTheQuietTime() = runTest {
        val reach = reach()
        reach.network(false)
        after(Reach.QUIET_MS - 1)
        assertNull(reach.status.value)
        after(1)
        assertEquals(Status.Offline, reach.status.value)
        // Back online, the message waits for a call to get through.
        reach.network(true)
        assertNull(reach.status.value)
    }

    @Test
    fun aServerThatDoesNotAnswerSpeaksAfterTheQuietTimeAndClearsOnTheFirstAnswer() = runTest {
        val reach = reach()
        reach.failed()
        after(5_000)
        reach.failed()
        assertNull(reach.status.value)
        after(Reach.QUIET_MS - 5_000)
        assertEquals(Status.Unreachable, reach.status.value)
        reach.reached()
        assertNull(reach.status.value)
    }

    @Test
    fun theTimeUnansweredCountsFromWhenTheNetworkCameBack() = runTest {
        val reach = reach()
        reach.network(false)
        reach.failed()
        after(8_000)
        reach.network(true)
        after(Reach.QUIET_MS - 1)
        assertNull(reach.status.value)
        after(1)
        assertEquals(Status.Unreachable, reach.status.value)
    }

    @Test
    fun aPullSaysWhatIsWrongAtOnce() = runTest {
        val reach = reach()
        reach.network(false)
        reach.surface()
        assertEquals(Status.Offline, reach.status.value)
    }

    @Test
    fun onlyFailuresThatNeverReachedTheServerAreTransient() {
        assertTrue(Reach.transient(UnknownHostException("starbridge.run")))
        assertTrue(Reach.transient(ConnectException()))
        assertTrue(Reach.transient(SocketTimeoutException()))
        assertTrue(Reach.transient(java.net.SocketException("Connection reset")))
        assertTrue(Reach.transient(ApiException(503, "unavailable", null)))
        assertFalse(Reach.transient(ApiException(401, "unauthorized", null)))
        assertFalse(Reach.transient(ApiException(429, "rate-limited", null)))
        assertFalse(Reach.transient(IllegalStateException()))
    }
}
