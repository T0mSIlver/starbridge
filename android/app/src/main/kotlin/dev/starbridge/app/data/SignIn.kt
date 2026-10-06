package dev.starbridge.app.data

import dev.starbridge.app.protocol.toB64
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * GitHub sign-in for the app, with PKCE (RFC 7636, PROTOCOL.md "Auth"). The redirect back carries
 * only a one-time code, which any app claiming starbridge://auth could catch; trading it for a
 * session needs the verifier, which never leaves this phone.
 */
object SignIn {
    /** 32 random bytes, base64url without padding: 43 characters. */
    fun newVerifier(): String = toB64(ByteArray(32).also { SecureRandom().nextBytes(it) })

    fun challenge(verifier: String): String = toB64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun url(server: String, verifier: String): String = "$server/v1/auth/github?app=1&challenge=${challenge(verifier)}"

    /**
     * The `code` of a sign-in redirect, else null: starbridge://auth?code=… from a self-hosted
     * server, or the App Link https://starbridge.run/app/auth?code=… from the hosted one.
     */
    fun code(redirect: String): String? {
        val uri = runCatching { URI(redirect) }.getOrNull() ?: return null
        val ours = (uri.scheme == "starbridge" && uri.host == "auth") ||
            (uri.scheme == "https" && uri.host == "starbridge.run" && uri.path == "/app/auth")
        if (!ours) return null
        return uri.rawQuery?.split('&')?.firstNotNullOfOrNull { part ->
            part.split('=', limit = 2).takeIf { it.size == 2 && it[0] == "code" }?.get(1)
        }?.takeIf { it.isNotBlank() }
    }
}
