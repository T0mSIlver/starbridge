package dev.starbridge.app

import dev.starbridge.app.data.SignIn
import dev.starbridge.app.data.SignIn.Redirect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The links that end GitHub sign-in (PROTOCOL.md, "Auth", #527).
class SignInTest {
    @Test fun readsEachLinkThatEndsASignIn() {
        assertEquals(Redirect.Code("sbc_a1", null), SignIn.redirect("starbridge://auth?code=sbc_a1"))
        assertEquals(Redirect.Code("9f2c", "Xy_z"), SignIn.redirect("starbridge://auth?code=9f2c&state=Xy_z"))
        assertEquals(Redirect.Code("9f2c", "Xy_z"), SignIn.redirect("https://starbridge.run/app/auth?state=Xy_z&code=9f2c"))
        assertEquals(Redirect.Code("9f2c", "Xy_z"), SignIn.redirect("https://starbridge.run/v1/auth/github/callback/app?code=9f2c&state=Xy_z"))
        assertEquals(Redirect.Denied("Xy_z"), SignIn.redirect("https://starbridge.run/v1/auth/github/callback/app?error=access_denied&state=Xy_z"))
        assertEquals(Redirect.Denied("Xy_z"), SignIn.redirect("starbridge://auth?error=access_denied&state=Xy_z"))
    }

    @Test fun ignoresOtherLinks() {
        listOf(
            "http://starbridge.run/app/auth?code=sbc_a1",
            "https://starbridge.run.example/app/auth?code=sbc_a1",
            "https://example.com/app/auth?code=sbc_a1",
            "https://starbridge.run/app/auth/more?code=sbc_a1",
            "https://starbridge.run/v1/auth/github/callback?code=9f2c&state=Xy_z",
            "https://starbridge.run/v1/auth/github/callback/app?code=9f2c",
            // Without the state, only an old server's own code: a bare GitHub code could be anyone's.
            "https://starbridge.run/app/auth?code=9f2c",
            "starbridge://auth?code=9f2c",
            "starbridge://auth?error=access_denied",
            "starbridge://other?code=sbc_a1",
            "https://starbridge.run/app/auth",
            "https://starbridge.run/app/auth?code=",
        ).forEach { assertNull(it, SignIn.redirect(it)) }
    }
}
