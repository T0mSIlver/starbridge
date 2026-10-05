# Launch copy (draft)

Check every claim against the shipped build before posting.

## 60-second demo (shot list)

| Time | Shot | On screen |
|---|---|---|
| 0-5 s | Laptop, three Claude Code sessions and a Codex session running | Title: "Four agents, one person" |
| 5-15 s | One session asks a question, then the phone on the desk buzzes | Lock-screen notification with the question and its options |
| 15-25 s | Tap the first option on the lock screen | The waiting session takes the answer as its next prompt and carries on |
| 25-33 s | The Codex session asks; answered from the browser | Codex picks up the answer in its live session |
| 33-50 s | An agent starts a release with `starbridge run` | The run's progress on the lock screen, then "Passed" |
| 50-60 s | Install command and URL | `curl -fsSL https://starbridge.run/install.sh \| sh`, starbridge.run |

Record it on real sessions, not a mock-up. Use captions instead of narration or music.

## Show HN

Title: Show HN: Starbridge, answer your coding agents from your phone

First comment:

> I run several coding agents at once, and most of my time went to noticing that one of them
> was stuck waiting for me. Starbridge turns those waits into notifications. An agent asks a
> question with a few options, my phone shows it on the lock screen, and the option I tap goes
> back into the waiting session as its next prompt. The session doesn't poll, so it spends no
> tokens while it waits.
>
> When an agent starts something that affects me, such as a release, an eval or heavy work on
> my machine, I follow its progress until it passes or fails. The app also shows what's left on
> each AI plan, read from CodexBar, with an optional alert before a window runs out.
>
> It works with Claude Code and Codex; Pi support is coming. Phones, browsers and machines each
> hold their own keys, and everything is encrypted end to end, so the server stores only
> ciphertext. The hosted server is free, or you can run your own: one Bun process and a SQLite
> file.
>
> Android app and web app today; no iOS app yet. MIT licence. I'd like to hear how you
> supervise parallel agents now, and what would make you trust a tool like this with them.

## X and Bluesky

> Starbridge: your coding agents ask, your phone buzzes, you tap an answer, and the waiting
> session carries on. Follow their releases and evals until they pass or fail.
> Claude Code and Codex, end-to-end encrypted, free or self-hosted. starbridge.run

(Under 300 characters, which fits Bluesky's limit.)

## Channels

- Hacker News (Show HN), on a weekday morning US Eastern time
- X and Bluesky, from the owner's accounts
- r/ClaudeAI and r/ChatGPTCoding
- The Claude Developers Discord
- CodexBar: its README or discussions, since Starbridge reads its data (ask its maintainer first)
- Lobsters, if someone with an account will post it
- Google Play listing, once the app is published there (its privacy page is starbridge.run/privacy)
