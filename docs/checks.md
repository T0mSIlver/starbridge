# Checks for repeated mistakes

Each mistake below reached review or a release more than once. The check beside it catches it
before review; a mistake with no check yet is open work. When a mistake comes back a second
time, add the cheapest check that fails on it (a type, a lint, a test) and its row here.

| Mistake | Check |
|---|---|
| A control or icon from another platform's design language (an alarm clock on the Mac, #1848) | `design/icons-by-job.test.ts`: fails on a glyph not in `design/icons-by-job.json`, and on a Material import in the web or the iPhone app |
| An icon or mark off-centre against its peers on the same screen | none yet |
| Copy that reads like a model wrote it: filler, narration, AI vocabulary | none yet |
| One behaviour worded two ways across clients or docs | none yet |
| A Settings subtitle that repeats its title or isn't needed (DESIGN.md) | none yet |
| Docs that no longer match the code | partial: `cli/test/contract.test.ts` and `cli/test/protocol-doc.test.ts` pin `cli/CONTRACT.md` and PROTOCOL.md's agent routes |
| A page, route or screen that no issue asked for | none yet |
| A status claim in a PR or issue without the run, file or screenshot behind it | none yet |
| Times shown with AM/PM in a 24-hour locale such as French | desktop only: `desktop/test/unit/clock.test.ts` |
| Uninstall missing something setup did: a file, a folder, the service, its log, lingering, a PATH line (#1494, #2040, #2041, #2098) | `cli/test/walk.test.ts` on Linux and macOS: installs with install.sh and with npm in a fresh HOME, sets up every agent, answers the first card, uninstalls, then compares HOME with what it was; `cli/test/integrations.test.ts`: every file setup writes belongs to an entry of `INTEGRATIONS` (`cli/src/setup/integrations.ts`), which status and uninstall read |
| Setup or uninstall changing or deleting the owner's own files in an agent's folder (#1324, #1493, #2098) | the same walk, whose HOME starts with the owner's settings, hooks and files inside Starbridge's folders, and must end with each byte for byte (JSON keys in order) |
| A terminal question that hangs under `curl \| sh` on macOS (#1882, #2036) | `cli/test/tty-prompt.test.ts`, and the walk, which answers every setup question on a pseudo-terminal on macOS too |
| A page load that grows back its requests or the work before the open questions show (#1454, #1455, #1458, #2097) | the web e2e's `loadBudget`: requests, bytes and directory reads before the open question shows, the open question shown while the rest of the inbox is held back, no image inside the kept list |
| A client picks the snooze or waiting update to keep with its own comparison of two times (as text, in whole seconds, the first to arrive on a tie: #1981, #1982, #1991, #2103) | `scripts/checks/order.test.ts`: fails on a line that compares two such times outside `laterSnooze` and `laterWaiting`; `rules.json`'s `order` cases run in the web, CLI, Android and iOS tests |
| A client stamps a snooze with its own clock only, so it loses to one stamped ahead elsewhere (#1981, #1991, #2103) | `rules.json`'s `order.stamp` cases in each client's tests, and the web e2e's `orderAcrossClients` (a browser 30 s ahead snoozes, another brings it back) |
