package dev.starbridge.app

import dev.starbridge.app.data.Api
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress

/**
 * A list ends where the server says no more follows (#1735): a page of large questions holds
 * fewer than 100 items and more may follow. A server from before `more` ends at a short page.
 */
class ItemPagesTest {
    private val server = MockWebServer().also { it.start(InetAddress.getLoopbackAddress(), 0) }

    @After
    fun close() = server.close()

    private fun page(more: String) =
        MockResponse(200, Headers.headersOf("content-type", "application/json"), """{"items":[],"cursor":"7"$more}""")

    @Test
    fun `more decides where a list ends, and a short page without it ends it`() = runBlocking {
        val api = Api(OkHttpClient(), server.url("/").toString().trimEnd('/'), null)
        server.enqueue(page(""","more":true"""))
        server.enqueue(page(""","more":false"""))
        server.enqueue(page(""))
        assertEquals(listOf(false, true, true), List(3) { api.items("decision", "0").last })
    }
}
