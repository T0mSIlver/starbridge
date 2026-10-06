package dev.starbridge.app

import dev.starbridge.app.data.Api
import dev.starbridge.app.data.ApiException
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.InetAddress
import kotlin.concurrent.thread

/** A deploy's short outage stays quiet (#250): the client retries before anyone hears of it. */
class ApiRetryTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun close() = servers.forEach { it.close() }

    private fun server(port: Int = 0) = MockWebServer().also { servers += it; it.start(InetAddress.getLoopbackAddress(), port) }

    private fun reply(code: Int, body: String = "") = MockResponse(code, Headers.headersOf("content-type", "application/json"), body)

    private val nonce = """{"nonce":"n"}"""

    @Test
    fun `a 502 and a 503 are retried until the server answers`() = runBlocking {
        val s = server()
        s.enqueue(reply(502))
        s.enqueue(reply(503))
        s.enqueue(reply(200, nonce))
        assertEquals("n", Api(OkHttpClient(), s.url("/").toString().trimEnd('/'), null).challenge())
        assertEquals(3, s.requestCount)
    }

    @Test
    fun `a refused connection is retried until the server is back`() = runBlocking {
        val down = server()
        val port = down.port
        down.close()
        thread {
            Thread.sleep(700)
            server(port).enqueue(reply(200, nonce))
        }
        assertEquals("n", Api(OkHttpClient(), "http://127.0.0.1:$port", null).challenge())
    }

    @Test
    fun `other errors reach the caller at once`() {
        val s = server()
        s.enqueue(reply(500, """{"error":"internal"}"""))
        val e = assertThrows(ApiException::class.java) { runBlocking { Api(OkHttpClient(), s.url("/").toString().trimEnd('/'), null).challenge() } }
        assertEquals(500, e.status)
        assertEquals(1, s.requestCount)
    }
}
