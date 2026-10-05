package dev.starbridge.app

import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Image
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.PromptScope
import dev.starbridge.app.data.PushSetting
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.SessionLink
import dev.starbridge.app.data.Source
import dev.starbridge.app.protocol.toB64
import java.time.Duration
import java.time.Instant

/** The owner's day, relative to [now]: screenshots pass a fixed instant. */
class Fake(private val now: Instant) {
    /** A 272x589 JPEG from src/test/resources/fake. */
    private fun mockup(scheme: String) = Image(
        toB64(javaClass.getResourceAsStream("/fake/mockup-$scheme.jpg")!!.readBytes()),
        272,
        589,
        alt = "The decision sheet, $scheme",
    )

    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes))
    private fun later(minutes: Long) = now.plus(Duration.ofMinutes(minutes))

    val prompts = listOf(
        Prompt(
            id = "p1",
            tool = "Bash",
            summary = "git push origin t/57-hook",
            description = "Push the permission hook branch",
            input = """{"command":"git push origin t/57-hook","description":"Push the permission hook branch"}""",
            scopes = listOf(
                PromptScope("session", "Allow for this session", "Bash(git push:*)"),
                PromptScope("project", "Always allow in starbridge", "Bash(git push:*)"),
            ),
            source = Source("dev box", "starbridge", "s1", title = "Hooks"),
            createdAt = ago(1),
            expiresAt = later(8),
        ),
        Prompt(
            id = "p2",
            tool = "Edit",
            summary = "/home/dev/work/localvoxtral/Sources/Speech/Recognizer.swift",
            description = null,
            input = """{"file_path":"/home/dev/work/localvoxtral/Sources/Speech/Recognizer.swift"}""",
            scopes = emptyList(),
            source = Source("Mac", "localvoxtral", "s2"),
            createdAt = ago(2),
            expiresAt = later(7),
            ended = "Answered on Mac",
            endedAt = now,
        ),
        Prompt(
            id = "p3",
            tool = "Bash",
            summary = "rm -rf build/",
            description = "Clean the build folder",
            input = """{"command":"rm -rf build/"}""",
            scopes = emptyList(),
            source = Source("dev box", "starbridge", "s1"),
            createdAt = ago(300),
            expiresAt = ago(291),
            ended = "Timed out: left to the keyboard",
            endedAt = ago(291),
        ),
    )

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
                title = "Merges",
                links = listOf(SessionLink("web", "https://claude.ai/code/session_01")),
            ),
            createdAt = ago(12),
        ),
        Decision(
            id = "d5",
            question = "Ship the light or the dark decision sheet first?",
            context = "Both mockups follow DESIGN.md. The interactive version is in the artifact.",
            options = listOf("Light", "Dark"),
            recommended = "Dark",
            default = "Ships dark first",
            defaultAt = later(60),
            source = Source("dev box", "starbridge", "design", title = "Decision sheet (#62)"),
            createdAt = ago(1),
            images = listOf(mockup("light"), mockup("dark")),
            links = listOf(Link("https://claude.ai/public/artifacts/0b3f0e7c")),
        ),
        Decision(
            id = "d6",
            question = "Which of the three settings layouts should ship?",
            context = "Each layout is live in the artifact, with your real devices. Its buttons send your pick straight to this session.",
            options = emptyList(),
            recommended = null,
            default = "Ships the roomy layout",
            defaultAt = later(240),
            source = Source("dev box", "starbridge", "settings", title = "Settings screen (#88)"),
            createdAt = ago(6),
            answerIn = Link("https://claude.ai/artifact/2ig2MyNRD484b7oZea5vkZ"),
        ),
        Decision(
            id = "d3",
            question = "Which Hetzner location for the VPS?",
            context = "A CX23 costs the same in Falkenstein, Nuremberg and Helsinki; latency from home differs by a few ms.",
            options = emptyList(),
            recommended = null,
            default = "Picks Falkenstein",
            // 10:00 tomorrow: the fallback says which day.
            defaultAt = later(20 * 60),
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

    private fun secondsAgo(s: Long) = now.minusSeconds(s)

    val runs = listOf(
        Run(
            id = "r1",
            title = "Mac e2e",
            reason = "uses your session and keyboard",
            source = Source("mac", "localvoxtral", "e2e", title = "localvoxtral e2e"),
            startedAt = secondsAgo(125),
            at = secondsAgo(4),
            progress = Run.Progress(3, 7, percent = false),
        ),
        Run(
            id = "r2",
            title = "Speech inference",
            reason = "loads the Mac's GPU",
            source = Source("mac", "localvoxtral", "eval-runner"),
            startedAt = secondsAgo(600),
            at = secondsAgo(20),
            progress = Run.Progress(42, 100, percent = true),
        ),
        Run(
            id = "r3",
            title = "Android e2e",
            reason = "runs the emulator on the dev box",
            source = Source("dev box", "starbridge", "s1"),
            startedAt = secondsAgo(900),
            at = secondsAgo(420),
            exitCode = 1,
            endedAt = secondsAgo(420),
        ),
        Run(
            id = "r4",
            title = "Release build",
            reason = "uses the Mac's signing keychain",
            source = Source("mac", "localvoxtral", "release"),
            startedAt = secondsAgo(1500),
            at = secondsAgo(1200),
            exitCode = 0,
            endedAt = secondsAgo(1200),
        ),
    )

    val windows = listOf(
        QuotaWindow("claude-5h", "claude", "5-hour", 81, later(110), Pace.RunsOut(later(50)), steadyPercent = 63),
        QuotaWindow("claude-week", "claude", "Weekly", 62, later(3120), Pace.Even, steadyPercent = 58, windowMinutes = 10080),
        QuotaWindow("zai-5h", "zai", "5-hour", 12, later(38), Pace.Unused(86), alert = true, steadyPercent = 87),
        QuotaWindow("codex-week", "codex", "Weekly", 34, later(1140), Pace.Unused(41), steadyPercent = 89, windowMinutes = 10080),
        QuotaWindow("mistral-month", "mistral", "Monthly credits", 55, later(12960), Pace.Even, steadyPercent = 52),
        QuotaWindow("gemini-day", "gemini", "Daily", 3, later(1400), Pace.Unknown),
    )

    /**
     * Snapshots the clock overtook: one ran out before its reset; two reset with no upload since.
     */
    val staleWindows = listOf(
        QuotaWindow("gemini-day", "gemini", "Daily", 100, later(40), Pace.RunsOut(ago(10)), alert = true, steadyPercent = 92),
        QuotaWindow("codex-5h", "codex", "5-hour", 100, ago(25), Pace.RunsOut(ago(90)), alert = true, steadyPercent = 100),
        QuotaWindow("claude-week", "claude", "Weekly", 97, ago(5), Pace.Even, steadyPercent = 100),
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
