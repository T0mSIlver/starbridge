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
| Setup or uninstall leaving files, folders, a service or lingering behind, or changing the owner's own agent settings (#2040, #2041, #2098) | Linux: `cli/test/walk.test.ts` installs with install.sh and with npm, sets up every agent, answers the first card and uninstalls in a fresh HOME, then compares HOME with what it was |
| A page load that grows back its requests or the work before the open questions show (#1454, #1455, #1458, #2097) | the web e2e's `loadBudget`: requests, bytes and directory reads before the open question shows, the open question shown while the rest of the inbox is held back, no image inside the kept list |
