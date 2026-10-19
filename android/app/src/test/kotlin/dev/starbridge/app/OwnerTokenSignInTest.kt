package dev.starbridge.app

import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
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
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
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
import java.util.concurrent.TimeUnit

/**
 * What an owner-token sign-in that fails says: the reason in the app's words, never the API's
 * code or OkHttp's message (Play testers stuck on the sign-in screen, 2026-10-19).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OwnerTokenSignInTest {
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    private fun store(client: OkHttpClient = OkHttpClient()): ServerStore {
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
        return ServerStore(disk, client, sodium, envelopes, Directories(sodium, envelopes), Pairings(sodium), Joins(sodium), alerts, "Phone", "https://starbridge.run", false, scope)
    }

    /** Signs in to the mock server and returns the notice the sign-in left. */
    private fun signIn(reply: MockResponse, client: OkHttpClient = OkHttpClient()): String? {
        http.enqueue(reply)
        http.start()
        val store = store(client)
        store.signInWithOwnerToken(http.url("/").toString(), "token")
        until { !store.busy.value && store.notice.value != null }
        return store.notice.value
    }

    private fun json(code: Int, body: String) = MockResponse(code, headersOf("content-type", "application/json"), body)

    @Test fun aWrongTokenSaysSo() {
        assertEquals("Wrong owner token.", signIn(json(401, """{"error":"unauthenticated","detail":"wrong owner token"}""")))
    }

    @Test fun aServerWithoutOwnerSignInSaysSo() {
        val said = signIn(json(404, """{"error":"not-configured","detail":"owner sign-in is off on this server"}"""))
        assertEquals("${http.hostName} doesn't take an owner token.", said)
    }

    @Test fun anotherWebsiteIsNoStarbridgeServer() {
        val said = signIn(MockResponse(200, headersOf("content-type", "text/html"), "<html>hello</html>"))
        assertEquals("No Starbridge server at ${http.hostName}.", said)
    }

    @Test fun aPageNotFoundIsNoStarbridgeServer() {
        val said = signIn(MockResponse(404, headersOf("content-type", "text/html"), "<html>not found</html>"))
        assertEquals("No Starbridge server at ${http.hostName}.", said)
    }

    @Test fun aServerThatDoesNotAnswerInTimeSaysSo() {
        val reply = MockResponse.Builder().code(200).body("""{"session":"s"}""").headersDelay(3, TimeUnit.SECONDS).build()
        val client = OkHttpClient.Builder().readTimeout(500, TimeUnit.MILLISECONDS).build()
        val said = signIn(reply, client)
        assertEquals("${http.hostName} didn't answer in time.", said)
    }

    @Test fun anAddressWithoutAScheme() {
        val store = store()
        store.signInWithOwnerToken("demo.example.com", "token")
        until { store.server.value != "https://starbridge.run" }
        // As typed in a browser: https is the default, not an error about the URL's scheme.
        assertEquals("https://demo.example.com", store.server.value)
        until { !store.busy.value && store.notice.value != null }
        assertEquals(false, store.notice.value!!.contains("scheme"))
    }

    @Test fun anAddressThatIsNoAddress() {
        val store = store()
        store.signInWithOwnerToken("https://demo example", "token")
        until { !store.busy.value && store.notice.value != null }
        assertEquals("That server address isn't valid.", store.notice.value)
    }
}
