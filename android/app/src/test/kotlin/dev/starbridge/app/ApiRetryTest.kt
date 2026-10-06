package dev.starbridge.app

import dev.starbridge.app.data.Api
import dev.starbridge.app.data.ApiException
import dev.starbridge.app.data.limitedUntil
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.concurrent.thread

/** A deploy's short outage stays quiet (#250): the client retries before anyone hears of it. */
class ApiRetryTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun close() {
        servers.forEach { it.close() }
        limitedUntil = 0L
    }

    private fun server(port: Int = 0) = MockWebServer().also { servers += it; it.start(InetAddress.getLoopbackAddress(), port) }

    private fun reply(code: Int, body: String = "") = MockResponse(code, Headers.headersOf("content-type", "application/json"), body)

    private fun limited(retryAfter: String) = MockResponse(429, Headers.headersOf("retry-after", retryAfter), "")

    private fun api(s: MockWebServer) = Api(OkHttpClient(), s.url("/").toString().trimEnd('/'), null)

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

    @Test
    fun `a 429 holds calls until its Retry-After, then a write is retried (#645)`() = runBlocking {
        val s = server()
        s.enqueue(limited("1"))
        s.enqueue(reply(204))
        val started = System.currentTimeMillis()
        api(s).logout()
        assertTrue(System.currentTimeMillis() - started >= 1_000)
        assertEquals(2, s.requestCount)
    }

    @Test
    fun `a 429 waiting longer than a call retries reaches the caller, and holds the next call (#645)`() {
        val s = server()
        s.enqueue(limited(DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(60))))
        val e = assertThrows(ApiException::class.java) { runBlocking { api(s).challenge() } }
        assertEquals(429, e.status)
        assertThrows(ApiException::class.java) { runBlocking { api(s).logout() } }
        assertEquals(1, s.requestCount)
    }

    @Test
    fun `a 429 without Retry-After is a cap, and reaches the caller at once`() {
        val s = server()
        s.enqueue(reply(429, """{"error":"too-many-waits"}"""))
        val e = assertThrows(ApiException::class.java) { runBlocking { api(s).challenge() } }
        assertEquals("too-many-waits", e.error)
        assertEquals(1, s.requestCount)
    }
}
