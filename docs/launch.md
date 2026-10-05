# Launch copy (draft)

Broad lines only: features may still change before launch. Check every claim against the
shipped build before posting.

## README hero paragraph

Starbridge sends the questions your coding agents ask you to your phone and browser. You answer
with one tap, and the answer goes back into the Claude Code session that is waiting on it. The
same app shows how much of each AI plan you have left (Claude, Codex, GLM, Mistral, and every
provider CodexBar reads) and flags a window that is about to reset with headroom unused. Agents encrypt every question
and answer, so the server stores ciphertext and routing ids. Use the free hosted server at
starbridge.run or run your own.

## 60-second demo (shot list)

| Time | Shot | On screen |
|---|---|---|
| 0-5 s | Laptop, three Claude Code sessions running | Title: "Three agents, one person" |
| 5-15 s | One session posts a decision, then the phone on the desk buzzes | Lock-screen notification with the question and two buttons |
| 15-25 s | Tap the recommended option on the lock screen | The waiting session picks up the answer and carries on |
| 25-35 s | A permission prompt from another session, answered from the browser | Allow once, the tool call runs |
| 35-45 s | Quota screen on the phone | Claude weekly limit, Codex and GLM windows, with pace for each |
| 45-52 s | A window that resets in an hour with headroom left | The amber alert on its quota card |
| 52-60 s | Install command and URL | `curl -fsSL https://starbridge.run/install.sh \| sh`, starbridge.run |

Record it on real sessions, not a mock-up. Use captions instead of narration or music.

## Show HN

Title: Show HN: Starbridge, answer your coding agents' questions from your phone

First comment:

> I run several Claude Code sessions at once, and most of my time went to noticing that one of
> them was stuck waiting for me. Starbridge turns those waits into notifications. An agent posts a
> question with two to four options and a default. My phone shows it on the lock screen, I tap an
> option, and the answer goes straight back into the waiting session. The session does not poll,
> so it spends no tokens while it waits.
>
> It also shows what each AI plan has left (it reads CodexBar) and flags a 5-hour or weekly
> window that is about to reset with headroom unused.
>
> Phones, browsers and machines each hold their own keys, and agents encrypt every message to the
> devices, so the server only stores ciphertext and routing ids. The hosted server is free. You
> can also host it yourself: one Bun process and a SQLite file.
>
> Android app and web page today; no iOS app yet. MIT licence. I'd like to hear how you supervise
> parallel agents now, and what would make you trust a tool like this with them.

## X and Bluesky

> Starbridge: your coding agents ask, your phone buzzes, you tap an answer, and the waiting Claude
> Code session carries on. It also shows what's left on your Claude, Codex and GLM plans.
> End-to-end encrypted, free hosted server or self-host. starbridge.run

(Under 300 characters, which fits Bluesky's limit.)

## Channels

- Hacker News (Show HN), on a weekday morning US Eastern time
- X and Bluesky, from the owner's accounts
- r/ClaudeAI and r/ChatGPTCoding
- The Claude Developers Discord
- CodexBar: its README or discussions, since Starbridge reads its data (ask its maintainer first)
- Lobsters, if someone with an account will post it
- Google Play listing, once the app is published there (its privacy page is starbridge.run/privacy)
