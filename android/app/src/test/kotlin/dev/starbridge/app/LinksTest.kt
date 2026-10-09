package dev.starbridge.app

import dev.starbridge.app.data.GitHubKind
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.githubLink
import dev.starbridge.app.data.label
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The same cases as the web's linkLabel test, so both clients label a GitHub link alike (#971).
@RunWith(RobolectricTestRunner::class)
class LinksTest {
    private val gh = "https://github.com/T0mSIlver/starbridge"
    private fun label(url: String, title: String? = null) = Link(url, title).label("starbridge")

    @Test fun gitHubLinksReadAsReferencesLedByAnotherRepo() {
        assertEquals("#86", label("$gh/pull/86/files#diff"))
        assertEquals("#86", label("$gh/pull/86", "Merge plan"))
        assertEquals("#171", label("https://GitHub.com/T0mSIlver/Starbridge/issues/171"))
        assertEquals("#12", label("$gh/discussions/12"))
        assertEquals("v0.1.2", label("$gh/releases/tag/v0.1.2"))
        assertEquals("v1.0-beta+1", label("$gh/releases/tag/v1.0-beta%2B1"))
        assertEquals("63141e8", label("$gh/commit/63141e89a2b4c"))
        assertEquals("CodexBar#412", label("https://github.com/steipete/CodexBar/pull/412"))
        assertEquals("CodexBar v1.2", label("https://github.com/steipete/CodexBar/releases/tag/v1.2"))
        assertEquals("Actions run", label("$gh/actions/runs/18234567890/job/5"))
        assertEquals("CI on #934", label("$gh/actions/runs/18234567890", "CI on #934"))
        assertEquals("T0mSIlver/starbridge/pulls", label("$gh/pulls"))
        assertEquals("GitHub", label("https://github.com/"))
        // Without a session's project, as for "Answer in", the repo always leads.
        assertEquals("starbridge#86", Link("$gh/pull/86").label())
    }

    @Test fun aGitHubLinksKindPicksItsOcticon() {
        fun kind(path: String) = githubLink("https://github.com/o/r$path")?.kind
        assertEquals(GitHubKind.Pull, kind("/pull/1"))
        assertEquals(GitHubKind.Issue, kind("/issues/2"))
        assertEquals(GitHubKind.Discussion, kind("/discussions/3"))
        assertEquals(GitHubKind.Run, kind("/actions/runs/4"))
        assertEquals(GitHubKind.Release, kind("/releases/tag/v1"))
        assertEquals(GitHubKind.Commit, kind("/commit/abcdef1"))
        assertEquals(GitHubKind.Other, kind("/pull/new"))
        assertEquals(GitHubKind.Other, kind("/releases"))
        assertNull(githubLink("http://github.com/o/r/pull/1"))
        assertNull(githubLink("https://gist.github.com/o/1"))
    }
}
