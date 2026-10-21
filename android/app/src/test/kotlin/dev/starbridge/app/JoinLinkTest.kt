package dev.starbridge.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.goterl.lazysodium.LazySodiumJava
import com.goterl.lazysodium.SodiumJava
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Phase
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.Secrets
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
import mockwebserver3.Dispatcher
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.rules.TemporaryFolder
import dev.starbridge.app.ui.setup.SetupActions
import dev.starbridge.app.ui.setup.SetupScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// A pairing link opened before this phone joins waits for the owner's tap.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class JoinLinkTest {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MockWebServer()

    @After
    fun stop() {
        scope.cancel()
        http.close()
    }

    @Test fun anOfferedLinkEndsWithTheSetupItCameIn() {
        // Every call gets an answer: the demo check (#2089) and the sign-out's logout both reach
        // the server, and a second call left unanswered held sign-out 10 s (#2143).
        http.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse(200, okhttp3.Headers.headersOf("content-type", "application/json"), "{}")
        }
        http.start()
        val sodium = Sodium(LazySodiumJava(SodiumJava()))
        val envelopes = Envelopes(sodium)
        val disk = Disk(tmp.newFolder(), object : Vault {
            override fun wrap(plain: ByteArray) = plain
            override fun unwrap(wrapped: ByteArray) = wrapped
        })
        val server = http.url("/").toString().trimEnd('/')
        disk.save(Saved(server, account = "acct", accountExists = true))
        disk.save(Secrets(session = "s"))
        val alerts = object : Alerts {
            override fun decision(decision: Decision, silent: Boolean) {}
            override fun cancel(id: String) {}
            override fun join(id: String, name: String) {}
            override fun prompt(prompt: Prompt) {}
            override fun cancelPrompt(prompt: Prompt) {}
            override fun run(run: Run) {}
        }
        val store = ServerStore(disk, OkHttpClient(), sodium, envelopes, Directories(sodium, envelopes), Pairings(sodium), Joins(sodium), alerts, "Phone", server, false, scope)
        assertEquals(Phase.NoDevice(accountExists = true), store.phase.value)

        val link = "https://starbridge.run/pair#c=x"
        store.offerJoinLink(link)
        assertEquals(link, store.joinLink.value)
        // Signed out, the link goes with the setup it came in, and later setups never see it.
        store.signOut()
        until { store.phase.value == Phase.SignedOut }
        assertEquals(null, store.joinLink.value)
        // Offered outside that setup, it is not kept.
        store.offerJoinLink(link)
        assertEquals(null, store.joinLink.value)
    }

    @Test fun aPairingLinkJoinsOnlyOnceTheOwnerSaysSo() {
        val link = "https://starbridge.run/pair#c=x"
        var offered by mutableStateOf<String?>(link)
        val joined = mutableListOf<String>()
        val actions = SetupActions({ "" }, { "" }, { _, _ -> }, {}, {}, { joined += it }, {}, {}, {}, {}, {}, dropJoinLink = { offered = null })
        compose.setContent { StarbridgeTheme { SetupScreen(Phase.NoDevice(accountExists = true), "https://starbridge.run", false, actions, {}, joinLink = offered) } }

        compose.onNodeWithText("Add this phone with this link?").assertExists()
        assertEquals(emptyList<String>(), joined)
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Add this phone with this link?").assertDoesNotExist()
        assertEquals(emptyList<String>(), joined)

        offered = link
        compose.onNodeWithText("Add this phone with this link?").assertExists()
        compose.onNode(hasText("Add this phone") and hasClickAction()).performClick()
        assertEquals(listOf(link), joined)
        compose.onNodeWithText("Add this phone with this link?").assertDoesNotExist()
    }
}
