package dev.starbridge.app.data

import dev.starbridge.app.protocol.toB64
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * GitHub sign-in for the app, with PKCE (RFC 7636, PROTOCOL.md "Auth"). Whatever comes back, any
 * app claiming starbridge://auth could catch it; trading it for a session needs the verifier,
 * which never leaves this phone.
 */
object SignIn {
    /** 32 random bytes, base64url without padding: 43 characters. */
    fun newVerifier(): String = toB64(ByteArray(32).also { SecureRandom().nextBytes(it) })

    fun challenge(verifier: String): String = toB64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun url(server: String, verifier: String): String = "$server/v1/auth/github?app=1&challenge=${challenge(verifier)}"

    /** What ends a sign-in. */
    sealed interface Redirect {
        /** The server's one-time code, after the browser finished the sign-in. */
        data class Code(val code: String) : Redirect

        /** GitHub's own redirect, which this app caught on starbridge.run (#527). */
        data class GitHub(val code: String, val state: String) : Redirect
    }

    /**
     * The sign-in a link ends, else null: GitHub's redirect to
     * https://starbridge.run/v1/auth/github/callback/app?code=…&state=…, or the server's
     * starbridge://auth?code=… (a self-hosted server) or https://starbridge.run/app/auth?code=…
     * (starbridge.run, when the browser finished the sign-in).
     */
    fun redirect(link: String): Redirect? {
        val uri = runCatching { URI(link) }.getOrNull() ?: return null
        val query = uri.rawQuery?.split('&')?.mapNotNull { part ->
            part.split('=', limit = 2).takeIf { it.size == 2 && it[1].isNotBlank() }?.let { it[0] to it[1] }
        }?.toMap().orEmpty()
        val code = query["code"] ?: return null
        val hosted = uri.scheme == "https" && uri.host == "starbridge.run"
        return when {
            hosted && uri.path == "/v1/auth/github/callback/app" -> query["state"]?.let { Redirect.GitHub(code, it) }
            hosted && uri.path == "/app/auth" -> Redirect.Code(code)
            uri.scheme == "starbridge" && uri.host == "auth" -> Redirect.Code(code)
            else -> null
        }
    }
}
