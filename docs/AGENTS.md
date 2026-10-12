# Docs guide

These rules apply to `README.md`, `docs/*.md`, `cli/README.md` and `server/README.md`. The site
serves all but `README.md` under /docs (`DOCS` in `web/src/lib/docs.ts`).

## Where things go

- Each page answers one reader question. Overview (`index.md`): what Starbridge is, the terms,
  how to start, runs, the recovery key. Agent instructions: what each harness supports and what
  setup installs. Notifications: what notifies you, and what to turn off. FAQ: everything else a
  user asks. The CLI: commands and flags, one line each.
- One home per fact. Other pages link to it in a few words; never restate it.
- Why a decision was made goes in `spec/`, not in the docs.
- Keep inbound links working. The apps link to the pages, the landing page to
  `/docs/faq#what-does-the-server-see`, and `README.md` to `/docs#start` and
  `/docs/tell-your-agents#what-each-harness-supports`. Renaming a heading changes its anchor.

## Terms

- A harness is the tool an agent runs in: Claude Code, Codex, Pi, opencode, Cursor, Antigravity,
  always in that order.
- The agent is the model working in a harness session.
- The background service is `starbridge agent`.
- A question picker is a harness's own tool for asking a question with options.

Keep one name per thing. When two harnesses behave the same, copy the sentence word for word:
"Each question shows at the keyboard and on your devices at once, and the first answer wins."

## Writing

- Cut what a user doesn't need to act. Paragraphs run 3 lines or so.
- Write to the reader as "you", in the present tense and the active voice.
- Use plain words: "use", not "leverage" or "utilize". Say what something does, with a name or a
  number, never how it feels.
- One idea per sentence, with its articles and verbs. No em dashes, no arrows in prose.
- No filler ("in order to", "note that"), no hedging, and no text about the page itself
  ("This section describes").
- Put the condition first: "On Windows, run …", not "Run … on Windows."
- In steps, use one action per step, in the imperative, followed by its result.
- Use backticks for commands, flags, paths and environment variables. Name UI labels exactly as
  the app shows them, such as Settings → Notifications.
- Link text names the target, never "here".
- Examples run as pasted.
- Date or version every claim about another tool ("Codex CLI 0.160 or later"), and link its own
  docs instead of copying them.
- Say what happens in the case the reader will hit: no terminal, a headless run, a failure.
- Use sentence case for headings.

Check every claim against the code before you merge.
