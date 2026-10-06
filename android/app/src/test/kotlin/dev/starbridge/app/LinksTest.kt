package dev.starbridge.app

import dev.starbridge.app.data.Link
import dev.starbridge.app.data.label
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The same cases as the web's linkLabel test, so both clients label a GitHub link alike (#171).
@RunWith(RobolectricTestRunner::class)
class LinksTest {
    @Test fun gitHubPullRequestsAndIssuesReadAsReferences() {
        assertEquals("T0mSIlver/starbridge#86", Link("https://github.com/T0mSIlver/starbridge/pull/86/files#diff").label())
        assertEquals("T0mSIlver/starbridge#171", Link("https://github.com/T0mSIlver/starbridge/issues/171").label())
        assertEquals("T0mSIlver/starbridge#86", Link("https://GitHub.com/T0mSIlver/starbridge/pull/86").label())
        assertEquals("github.com/T0mSIlver/starbridge/pulls", Link("https://github.com/T0mSIlver/starbridge/pulls").label())
        assertEquals("Merge plan", Link("https://github.com/T0mSIlver/starbridge/pull/86", "Merge plan").label())
    }
}
