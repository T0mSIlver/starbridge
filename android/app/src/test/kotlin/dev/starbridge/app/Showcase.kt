package dev.starbridge.app

import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Image
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.SessionLink
import dev.starbridge.app.data.Source
import dev.starbridge.app.protocol.toB64
import java.time.Duration
import java.time.Instant

/**
 * Neutral data for the shots the public sees, relative to [now]: the landing page's phones and the
 * Play Store screenshots (#421) share these machines, projects and questions.
 */
class Showcase(private val now: Instant) {
    private fun ago(m: Long) = now.minus(Duration.ofMinutes(m))
    private fun secondsAgo(s: Long) = now.minusSeconds(s)

    /** A 340x210 PNG from src/test/resources/fake: a page laid out two ways. */
    private fun layout(v: String) = Image(toB64(javaClass.getResourceAsStream("/fake/hero-$v.png")!!.readBytes()), 340, 210, alt = "Layout ${v.uppercase()}")

    private val workstation = Source("workstation", "billing-api", "rename-user-id-column", machineKind = "desktop")
    private val buildServer = Source("build server", "web-app", "ship-checkout-v2", machineKind = "server", links = listOf(SessionLink("web", "https://claude.ai/code/session_01")))
    private val laptop = Source("laptop", "web-app", "checkout-layouts", machineKind = "laptop", links = listOf(SessionLink("web", "https://claude.ai/code/session_02")))

    val runs = listOf(
        Run("r1", "Integration tests", "Uses the shared staging database", Source("build server", "billing-api", "integration", machineKind = "server"), startedAt = secondsAgo(372), at = secondsAgo(4), progress = Run.Progress(34, 120, percent = false)),
    )

    val waiting = Decision(
        id = "d1",
        question = "Rename the user_id column now, or after Friday's release?",
        context = "Renaming now touches 14 queries and needs a migration. After the release, nothing else is in flight.",
        options = listOf("Now", "After the release"),
        recommended = "After the release",
        default = null,
        defaultAt = null,
        source = workstation,
        createdAt = ago(3),
        agent = "codex",
        waiting = true,
        waitingSince = secondsAgo(130),
        replies = true,
    )

    val merge = Decision(
        id = "d2",
        question = "Merge the API change before the checkout PR?",
        context = "Both touch `api/orders.ts`. Merging the API first lets the checkout PR rebase onto the final routes:\n```\ngit rebase origin/main\nnpm test\n```\nThe checkout PR then needs one more review.",
        options = listOf("API first", "Checkout first"),
        recommended = "API first",
        default = null,
        defaultAt = null,
        source = buildServer,
        createdAt = ago(12),
        agent = "claude-code",
        replies = true,
    )

    val pick = Decision(
        id = "d3",
        question = "Which checkout layout should I keep?",
        context = "Both are built on their own branches.",
        options = listOf("Keep A", "Keep B"),
        recommended = "Keep A",
        default = null,
        defaultAt = null,
        source = laptop,
        createdAt = ago(8),
        agent = "claude-code",
        images = listOf(layout("a"), layout("b")),
    )

    val answered = Decision(
        id = "d4",
        question = "Bump the Node version in CI?",
        context = "",
        options = listOf("Yes", "No"),
        recommended = "Yes",
        default = null,
        defaultAt = null,
        source = Source("cloud", "web-app", "node-version", machineKind = "cloud"),
        createdAt = ago(190),
        answer = "Yes",
        answeredAt = ago(178),
    )

    val decisions = listOf(waiting, merge, pick, answered)
}
