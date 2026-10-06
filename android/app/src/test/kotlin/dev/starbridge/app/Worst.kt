package dev.starbridge.app

import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Link
import dev.starbridge.app.data.Member
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.PromptScope
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.data.Run
import dev.starbridge.app.data.SessionLink
import dev.starbridge.app.data.Source
import java.time.Duration
import java.time.Instant

/**
 * The longest content the owner could see, relative to [now]: long questions, options, machine,
 * project and session names, unbroken commands, and many items. For the layout audit, not the
 * mockups.
 */
class Worst(private val now: Instant) {
    private val fake = Fake(now)
    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes))
    private fun later(minutes: Long) = now.plus(Duration.ofMinutes(minutes))

    private val links = listOf(SessionLink("web", "https://claude.ai/code/session_01"))
    private val machines = listOf("build-runner-eu-central-mac-studio-2", "dev box", "Tom's MacBook Pro (work, 16-inch)", "ci-hetzner-cx23-falkenstein-01")
    private val projects = listOf("localvoxtral-speech-polish-pipeline", "starbridge", "vidtheque-android-jetpack-compose", "x")

    private fun source(i: Int) = Source(
        machines[i % machines.size],
        projects[i % projects.size],
        "orchestrate-the-nightly-release-and-merge-every-green-pull-request-$i",
        title = "Orchestrate the nightly release, then merge every green pull request in the queue ($i)",
        links = links,
        machineKind = listOf("server", "laptop", "desktop", "cloud")[i % 4],
    )

    private val longQuestion = "Should I rebase the forty-two open pull requests onto the new protocol package before tonight's release, or wait until the owner has reviewed the migration plan for the Android client?"
    private val longOptions = listOf(
        "Rebase all of them now and run the full Android and web end-to-end suites",
        "Wait until tomorrow morning",
        "Rebase only the ones that touch packages/protocol",
        "Skip",
    )

    val decisions: List<Decision> = (0 until 12).map { i ->
        Decision(
            id = "w$i",
            question = if (i % 3 == 2) "Ship it?" else longQuestion,
            context = "Supercalifragilisticexpialidocious_identifier_that_never_breaks_anywhere_in_the_middle " +
                "and `packages/protocol/src/very/deeply/nested/path/to/a/file/named/Something.kt` changed.",
            options = if (i % 2 == 0) longOptions else listOf("Yes", "No"),
            recommended = if (i % 2 == 0) longOptions[0] else "Yes",
            default = if (i == 1) "No" else null,
            defaultAt = if (i == 1) later(14 * 60) else null,
            source = source(i),
            createdAt = ago(3L + i * 97),
            agent = if (i % 2 == 0) "claude-code" else "codex",
            waiting = i < 4,
            waitingSince = if (i < 4) ago(60L * 26 + i) else null,
            links = listOf(Link("https://claude.ai/artifact/Xq7pLm2VnR4tBz9KcW1sYdXq7pLm2VnR4tBz9KcW1sYd", "the full migration plan for every package in the monorepo")),
            replies = true,
            images = if (i == 4) fake.decisions.first { it.id == "d3" }.images else emptyList(),
        )
    } + (0 until 6).map { i ->
        Decision(
            id = "h$i",
            question = longQuestion,
            context = "",
            options = longOptions,
            recommended = null,
            default = null,
            defaultAt = null,
            source = source(i + 1),
            createdAt = ago(600L + i * 60),
            answer = longOptions[i % longOptions.size],
            answeredAt = ago(590L + i * 60),
        )
    }

    val prompts = listOf(
        Prompt(
            id = "wp1",
            tool = "Bash",
            summary = "curl -fsSL https://raw.githubusercontent.com/T0mSIlver/starbridge/main/packages/cli/scripts/install-the-agent-and-register-this-machine.sh | bash -s -- --server https://starbridge.example.internal",
            description = "Install the Starbridge agent on this machine and register it with the self-hosted server behind the reverse proxy",
            input = """{"command":"curl -fsSL https://raw.githubusercontent.com/T0mSIlver/starbridge/main/packages/cli/scripts/install-the-agent-and-register-this-machine.sh | bash -s -- --server https://starbridge.example.internal --name build-runner-eu-central-mac-studio-2 --token ${"x".repeat(180)}","description":"Install the Starbridge agent on this machine and register it with the self-hosted server behind the reverse proxy","timeout":600000}""",
            scopes = listOf(
                PromptScope("session", "This session", "Bash(curl:*)"),
                PromptScope("project", "Always in localvoxtral-speech-polish-pipeline", "Bash(curl:*)"),
                PromptScope("user", "Always, in every project on every machine", "Bash(curl:*)"),
            ),
            source = source(0),
            createdAt = now.minusSeconds(72),
            expiresAt = later(8),
            agent = "claude-code",
        ),
        Prompt(
            id = "wp2",
            tool = "mcp__github_enterprise_server__create_or_update_file_contents",
            summary = "packages/protocol/src/very/deeply/nested/path/to/a/file/named/SomethingRatherLong.kt",
            description = null,
            input = """{"path":"packages/protocol/src/very/deeply/nested/path/to/a/file/named/SomethingRatherLong.kt"}""",
            scopes = emptyList(),
            source = source(2),
            createdAt = now.minusSeconds(30),
            expiresAt = later(9),
        ),
    )

    val runs = listOf(
        Run("wr1", "Android end-to-end suite on every emulator API level", "uses your session, keyboard and the Mac's signing keychain", source(0), startedAt = now.minusSeconds(3 * 3600 + 372), at = now.minusSeconds(4), progress = Run.Progress(1234, 12000, percent = false)),
        Run("wr2", "Release build", "runs the emulator on the dev box", source(1), startedAt = now.minusSeconds(95), at = now.minusSeconds(20), progress = Run.Progress(97, 100, percent = true)),
        Run("wr3", "Nightly speech inference evaluation with whisper-large-v3", "uses the Mac's GPU", source(2), startedAt = now.minusSeconds(9000), at = now.minusSeconds(420), exitCode = 137, endedAt = now.minusSeconds(420)),
    )

    /** Every provider, long window names, and resets weeks out. */
    val windows = listOf(
        QuotaWindow("claude-5h", "claude", "5-hour", 81, later(110), Pace.RunsOut(later(50)), alert = true, steadyPercent = 63, takenAt = ago(1)),
        QuotaWindow("claude-week", "claude", "Weekly (Opus and every other model combined)", 99, later(60 * 24 * 6 + 1439), Pace.RunsOut(later(60 * 24 * 5)), alert = true, steadyPercent = 12, windowMinutes = 10080, takenAt = ago(1)),
        QuotaWindow("gemini-day", "gemini", "Daily", 100, later(1439), Pace.RunsOut(ago(140)), alert = true, steadyPercent = 48, takenAt = ago(1)),
        QuotaWindow("codex-week", "codex", "Weekly", 34, later(60 * 24 * 6 + 1380), Pace.Unused(41), steadyPercent = 72, windowMinutes = 10080, takenAt = ago(1)),
        QuotaWindow("zai-5h", "zai", "5-hour", 12, later(38), Pace.Unknown, takenAt = ago(1)),
        QuotaWindow("mistral-month", "mistral", "Monthly credits for the team plan", 55, later(60 * 24 * 29 + 1439), Pace.Even, steadyPercent = 60, machine = "build-runner-eu-central-mac-studio-2", takenAt = ago(1)),
    )

    val members = (0 until 9).map { i ->
        Member("wm$i", if (i % 2 == 0) "Firefox on Tom's MacBook Pro (work, 16-inch, 2025)" else machines[i % machines.size], if (i < 5) Kind.Device else Kind.Machine, ago(60L * 24 * (i + 1) * 37), current = i == 0)
    }

    val approval = Approval.Found("Chrome on build-runner-eu-central-mac-studio-2 (self-hosted CI)", Kind.Machine, "7KQ2-M9XD-4TPV-HB3N-R8CE-WY6F")

    val server = "https://starbridge.very-long-subdomain.home.example.internal:8443"
}
