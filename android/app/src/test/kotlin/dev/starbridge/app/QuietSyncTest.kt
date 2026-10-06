package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.protocol.envelopeJson
import dev.starbridge.app.protocol.toB64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * The pull-to-refresh indicator follows `busy`: a pull raises it, even while a quiet sync holds
 * the lock, and the syncs the app runs on launch and resume leave it down (#414).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class QuietSyncTest {
    private val sodium = Sodium(LazySodiumJava(SodiumJava()))
    private val envelopes = Envelopes(sodium)
    private val directories = Directories(sodium, envelopes)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    @Test
    fun onlyAPullShowsTheSyncRunning() {
        val account = "acct"
        val signKeys = sodium.signKeyPair()
        val boxKeys = sodium.boxKeyPair()
        val phone = Member("phone", "device", "Phone", toB64(boxKeys.public), toB64(signKeys.public))
        val entries = listOf(envelopeJson(directories.genesisEntry(account, phone, signKeys.secret, sodium.signKeyPair(), "2026-10-06T12:00:00Z")))
        val dir = directories.verify(entries, account, null)

        // Each sync starts with the directory, held there until the test lets it go.
        val arrived = LinkedBlockingQueue<Unit>()
        val release = Semaphore(0)
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.encodedPath == "/v1/directory") {
                    arrived.put(Unit)
                    release.tryAcquire(10, TimeUnit.SECONDS)
                    return MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), """{"entries":[]}""")
                }
                return MockResponse(404, okhttp3.Headers.headersOf(), "")
            }
        }
        http.start()

        val identity = object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        }
        val disk = Disk(Files.createTempDirectory("starbridge").toFile(), identity)
        val server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = account, accountExists = true, me = phone, pin = Pin(dir.length, dir.head), entries = entries))
        disk.save(Secrets(session = "s", boxPk = toB64(boxKeys.public), boxSk = toB64(boxKeys.secret), signPk = toB64(signKeys.public), signSk = toB64(signKeys.secret)))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, directories, Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)

        store.refresh(shown = false)
        assertNotNull(arrived.poll(10, TimeUnit.SECONDS))
        assertFalse(store.busy.value)

        // A pull while the quiet sync still runs shows at once, then waits its turn.
        store.refresh()
        waitUntil { store.busy.value }
        release.release()
        assertNotNull(arrived.poll(10, TimeUnit.SECONDS))
        assertTrue(store.busy.value)
        release.release()
        waitUntil { !store.busy.value }
    }

    private fun waitUntil(condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 10_000
        while (!condition()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(20)
        }
    }
}
