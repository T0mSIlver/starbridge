package dev.starbridge.app

import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.SessionLink
import dev.starbridge.app.data.Source
import java.time.Duration
import java.time.Instant

/** The owner's day, relative to [now]: screenshots pass a fixed instant. */
class Fake(private val now: Instant) {
    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes))
    private fun later(minutes: Long) = now.plus(Duration.ofMinutes(minutes))

    val decisions = listOf(
        Decision(
            id = "d1",
            question = "Run speech inference on the Mac while you're away?",
            context = "The localvoxtral eval needs the Mac's GPU for about 40 minutes. Anything you start there meanwhile runs slower.",
            options = listOf("Yes, run it now", "Wait until tonight", "Skip this eval"),
            recommended = "Yes, run it now",
            default = "Waits until tonight",
            defaultAt = later(480),
            source = Source("dev box", "localvoxtral", "eval-runner"),
            createdAt = ago(3),
        ),
        Decision(
            id = "d2",
            question = "Merge the server PR before the CLI PR?",
            context = "Both touch `packages/protocol`. Merging the server first lets the CLI rebase onto the final routes:\n```\ngit rebase origin/main\npnpm test\n```\nThe CLI PR then needs one more review.",
            options = listOf("Server first", "CLI first"),
            recommended = "Server first",
            default = "Merges the server first",
            defaultAt = later(30),
            source = Source(
                "dev box",
                "starbridge",
                "8f3c2a1e-5b7d-4c9a-a1f2-3e4d5c6b7a89",
                title = "Starbridge orchestrator",
                links = listOf(SessionLink("web", "https://claude.ai/code/session_01")),
            ),
            createdAt = ago(12),
        ),
        Decision(
            id = "d3",
            question = "Which Hetzner location for the VPS?",
            context = "A CX23 costs the same in Falkenstein, Nuremberg and Helsinki; latency from home differs by a few ms.",
            options = emptyList(),
            recommended = null,
            default = "Picks Falkenstein",
            defaultAt = later(120),
            source = Source("dev box", "starbridge", "deploy"),
            createdAt = ago(40),
        ),
        Decision(
            id = "d4",
            question = "Spend the Codex reset credit now?",
            context = "The weekly limit resets in 19 h with 66% left.",
            options = listOf("Spend it", "Not yet"),
            recommended = "Not yet",
            default = "Keeps the credit",
            defaultAt = null,
            source = Source("dev box", "starbridge", "orchestrator"),
            createdAt = ago(150),
            answer = "Not yet",
            answeredAt = ago(95),
        ),
    )

    val windows = listOf(
        QuotaWindow("claude-5h", "Claude", "5-hour", 81, later(110), Pace.RunsOut(later(50)), steadyPercent = 63),
        QuotaWindow("claude-week", "Claude", "Weekly", 62, later(3120), Pace.Even, steadyPercent = 58),
        QuotaWindow("zai-5h", "Z.ai GLM", "5-hour", 12, later(38), Pace.Unused(86), alert = true, steadyPercent = 87),
        QuotaWindow("codex-week", "Codex", "Weekly", 34, later(1140), Pace.Unused(41), steadyPercent = 89),
        QuotaWindow("mistral-month", "Mistral", "Monthly credits", 55, later(12960), Pace.Even, steadyPercent = 52),
        QuotaWindow("gemini-day", "Gemini", "Daily", 3, later(1400), Pace.Unknown),
    )

    val members = listOf(
        Member("m1", "Pixel 11 Pro", Kind.Device, ago(60 * 24 * 3), current = true),
        Member("m2", "Firefox on the Mac", Kind.Device, ago(60 * 24 * 3)),
        Member("m3", "dev box", Kind.Machine, ago(60 * 24 * 3)),
        Member("m4", "Mac", Kind.Machine, ago(60 * 24 * 2)),
        Member("m5", "mini PC", Kind.Machine, ago(60 * 20)),
    )

    val approval = Approval.Found("CI runner on the Mac", Kind.Machine, "7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F")

    val push = PushSetting("fcm", fcmAvailable = true, distributors = emptyList(), registered = true)

    val recoveryWords = listOf(
        "orbit", "lantern", "cobalt", "meadow", "quartz", "harbor",
        "velvet", "ember", "signal", "tundra", "falcon", "pebble",
        "copper", "nimbus", "saddle", "violet", "ridge", "anchor",
        "maple", "comet", "thistle", "beacon", "glacier", "summit",
    )
}
