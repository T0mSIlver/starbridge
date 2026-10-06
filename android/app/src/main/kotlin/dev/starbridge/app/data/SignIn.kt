package dev.starbridge.app.data

import dev.starbridge.app.protocol.toB64
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * GitHub sign-in for the app, with PKCE (RFC 7636, PROTOCOL.md "Auth"). GitHub binds its code to
 * the challenge, so whoever catches the redirect, trading the code for a session needs the
 * verifier, which never leaves this phone.
 */
object SignIn {
    /** 32 random bytes, base64url without padding: 43 characters. */
    fun newVerifier(): String = toB64(ByteArray(32).also { SecureRandom().nextBytes(it) })

    fun challenge(verifier: String): String = toB64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun url(server: String, verifier: String): String = "$server/v1/auth/github?app=1&challenge=${challenge(verifier)}"

    /** What ends a sign-in. */
    sealed interface Redirect {
        /** The code to trade, and the sign-in's state: its challenge. A server before #527 sends no state. */
        data class Code(val code: String, val state: String?) : Redirect

        /** The owner turned GitHub down, or GitHub failed. */
        data class Denied(val state: String) : Redirect
    }

    /**
     * The sign-in a link ends, else null: GitHub's redirect, which this app catches on
     * starbridge.run at /v1/auth/github/callback/app, or the server's, when the browser got
     * GitHub's: https://starbridge.run/app/auth on starbridge.run, starbridge://auth elsewhere.
     * Each carries the state, the sign-in's challenge, which [ServerStore] checks.
     */
    fun redirect(link: String): Redirect? {
        val uri = runCatching { URI(link) }.getOrNull() ?: return null
        val hosted = uri.scheme == "https" && uri.host == "starbridge.run"
        val gitHub = hosted && uri.path == "/v1/auth/github/callback/app"
        val ours = gitHub || (hosted && uri.path == "/app/auth") || (uri.scheme == "starbridge" && uri.host == "auth")
        if (!ours) return null
        val query = uri.rawQuery?.split('&')?.mapNotNull { part ->
            part.split('=', limit = 2).takeIf { it.size == 2 && it[1].isNotBlank() }?.let { it[0] to it[1] }
        }?.toMap().orEmpty()
        val code = query["code"]
        val state = query["state"]
        // Only a server from before #527 sends a code without the state: its own one-time code.
        return when {
            code != null && (state != null || code.startsWith("sbc_")) -> Redirect.Code(code, state)
            query["error"] != null && state != null -> Redirect.Denied(state)
            else -> null
        }
    }
}
