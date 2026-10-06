package dev.starbridge.app

import dev.starbridge.app.data.SignIn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The redirects that end GitHub sign-in (PROTOCOL.md, "Auth", #527).
class SignInTest {
    @Test fun readsTheCodeOfEitherRedirect() {
        assertEquals("sbc_a1", SignIn.code("starbridge://auth?code=sbc_a1"))
        assertEquals("sbc_a1", SignIn.code("https://starbridge.run/app/auth?state=x&code=sbc_a1"))
    }

    @Test fun ignoresOtherLinks() {
        listOf(
            "http://starbridge.run/app/auth?code=sbc_a1",
            "https://starbridge.run.example/app/auth?code=sbc_a1",
            "https://example.com/app/auth?code=sbc_a1",
            "https://starbridge.run/app/auth/more?code=sbc_a1",
            "https://starbridge.run/v1/auth?code=sbc_a1",
            "starbridge://other?code=sbc_a1",
            "https://starbridge.run/app/auth",
            "https://starbridge.run/app/auth?code=",
        ).forEach { assertNull(it, SignIn.code(it)) }
    }
}
