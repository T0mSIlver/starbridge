package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Vault
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Joins
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Sodium
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Headers.Companion.headersOf
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** On a demo server, Add this phone says how to join: the server says it is one (#2089). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class DemoHintTest {
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private fun json(body: String, code: Int = 200) = MockResponse(code, headersOf("content-type", "application/json"), body)

    /** Signs in to an account with a device, on a server whose `/v1/demo` gives [demo]. */
    private fun signIn(demo: MockResponse): ServerStore {
        val asked = java.util.concurrent.atomic.AtomicInteger()
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/v1/auth/owner" -> json("""{"session":"s"}""")
                "/v1/me" -> json("""{"account":"acct","member":null,"role":"device"}""")
                "/v1/directory" -> json("""{"entries":[{"v":1}]}""")
                "/v1/demo" -> demo.also { asked.incrementAndGet() }
                else -> json("""{"error":"not-found"}""", 404)
            }
        }
        http.start()
        val sodium = Sodium(LazySodiumJava(SodiumJava()))
        val envelopes = Envelopes(sodium)
        val disk = Disk(tmp.newFolder(), object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        })
        disk.save(Saved("https://starbridge.run"))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, Directories(sodium, envelopes), Pairings(sodium), Joins(sodium), alerts, "Phone", "https://starbridge.run", false, scope)
        store.signInWithOwnerToken(http.url("/").toString(), "token")
        until { store.phase.value == Phase.NoDevice(accountExists = true) && asked.get() > 0 && !store.busy.value }
        return store
    }

    @Test fun aDemoServerSaysSo() {
        val store = signIn(json("""{"demo":true}"""))
        until { store.demo.value }
    }

    @Test fun anyOtherServerDoesNot() {
        val store = signIn(json("""{"error":"not-found"}""", 404))
        Thread.sleep(200)
        assertEquals(false, store.demo.value)
    }
}
