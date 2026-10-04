---
name: starbridge
description: A ship's bridge at night. A calm instrument panel where one amber beacon marks what needs you.
scheme: light-and-dark
# Every colour is a hex (#rrggbb or #rrggbbaa) so the Kotlin output can read it.
# Both schemes carry the same keys; the generator refuses a key missing from one.
colors:
  light:
    bg: "#f4f5f8"
    surface: "#ffffff"
    surface2: "#eceef3"
    line: "#dcdfe7"
    line-strong: "#c3c8d4"
    fg: "#141821"
    fg2: "#525a6b"
    fg3: "#818999"
    accent: "#b45f06"
    accent-hi: "#9a4f00"
    on-accent: "#ffffff"
    accent-soft: "#b45f061a"
    ok: "#1f7a45"
    ok-soft: "#1f7a451a"
    warn: "#7d6400"
    warn-soft: "#7d64001f"
    bad: "#c0352b"
    bad-soft: "#c0352b1a"
    info: "#2a62c9"
    info-soft: "#2a62c91a"
    scrim: "#0b0e1499"
  dark:
    bg: "#0b0e14"
    surface: "#131823"
    surface2: "#1b2130"
    line: "#252c3c"
    line-strong: "#343d52"
    fg: "#e8ebf2"
    fg2: "#9aa3b5"
    fg3: "#687186"
    accent: "#f5a83b"
    accent-hi: "#ffc067"
    on-accent: "#1a0f00"
    accent-soft: "#f5a83b1f"
    ok: "#5ccf8a"
    ok-soft: "#5ccf8a1f"
    warn: "#e5c454"
    warn-soft: "#e5c4541f"
    bad: "#ff7b72"
    bad-soft: "#ff7b721f"
    info: "#7aa7ff"
    info-soft: "#7aa7ff1f"
    scrim: "#000000a6"
# Two faces. `sans` sets everything; `mono` sets code only (the `code` role).
# Each platform binds its own files.
fonts:
  sans: "Archivo VF, system-ui, -apple-system, sans-serif"
  mono: "JetBrains Mono VF, ui-monospace, SFMono-Regular, monospace"
# Sizes in px (sp on Android), lineHeight as a multiple, letterSpacing in em.
# `tabular: true` turns on tabular figures (tnum) so numbers line up.
typography:
  title:
    font: sans
    size: 26
    weight: 600
    lineHeight: 1.15
    letterSpacing: -0.025
  heading:
    font: sans
    size: 18
    weight: 600
    lineHeight: 1.25
    letterSpacing: -0.015
  question:
    font: sans
    size: 17
    weight: 520
    lineHeight: 1.35
    letterSpacing: -0.01
  body:
    font: sans
    size: 15
    weight: 400
    lineHeight: 1.5
    letterSpacing: 0
  action:
    font: sans
    size: 15
    weight: 600
    lineHeight: 1.2
    letterSpacing: -0.005
  small:
    font: sans
    size: 13
    weight: 400
    lineHeight: 1.4
    letterSpacing: 0
  figure:
    font: sans
    size: 28
    weight: 600
    lineHeight: 1
    letterSpacing: -0.02
    tabular: true
  machine:
    font: sans
    size: 13
    weight: 400
    lineHeight: 1.4
    letterSpacing: 0
    tabular: true
  label:
    font: sans
    size: 13
    weight: 600
    lineHeight: 1.3
    letterSpacing: 0
  code:
    font: mono
    size: 13
    weight: 400
    lineHeight: 1.5
    letterSpacing: 0
# px on the web, dp on Android.
spacing:
  s1: 4
  s2: 8
  s3: 12
  s4: 16
  s5: 20
  s6: 24
  s8: 32
  s10: 40
radius:
  sm: 8
  md: 14
  lg: 20
  pill: 999
size:
  tap: 48
  bar: 64
  rail: 240
  content: 720
motion:
  fast: 150
  state: 250
---

# Starbridge design

The frontmatter above is the design system. `web/scripts/tokens.ts` turns it
into `web/src/styles/tokens.css` and `type.css`, and into
`android/app/src/main/kotlin/dev/starbridge/app/ui/theme/Tokens.kt`, so both
clients share colours, type and spacing. Change a value here, then run
`bun web/scripts/tokens.ts`; `--check` fails when an output is stale.

## The look

Function over form (decided 2026-10-04, SPEC.md). The palette is a neutral
default: blue-black in the dark scheme, cool paper in the light one. Colour is
fixed only where it carries meaning: the amber accent marks what needs the
owner (open decisions, the recommended answer, the primary button), and `ok`,
`warn` and `bad` mark quota states. On Android the app uses Material You
dynamic colour from the wallpaper, and these tokens are the fallback; the
meaning colours stay fixed there too.

One face, the sans, sets everything a person reads, numbers included, with
tabular figures where they line up. Mono is for code only: Markdown code in a
decision's context.

## Rules

- Write tokens, never a raw colour, size or radius. A component that needs a
  new primitive adds it here in the same commit and says why.
- Amber is for "needs you" only. Quota state uses `ok`, `warn` and `bad`, and
  each tone comes with a word ("on pace", "will run out", "unused"), never
  colour alone.
- Light and dark are peers and follow the system setting. Every screen ships
  in both.
- Mobile width first. Tap targets are at least `size.tap`. Wider screens add a
  side rail (`size.rail`) and cap content at `size.content`.
- Labels are sentence case, never uppercase.
- Cards use `radius.md`, buttons `radius.pill`, matching Material 3 Expressive
  on Android.

## Roles

| Token | Use |
|---|---|
| `bg` | page ground |
| `surface`, `surface2` | cards; inset areas inside a card |
| `line`, `line-strong` | dividers; input and card borders |
| `fg`, `fg2`, `fg3` | text; secondary text; hints and disabled |
| `accent`, `on-accent`, `accent-soft` | the beacon; text on it; its tint behind a recommended option |
| `ok`, `warn`, `bad`, `info` (+ `-soft`) | quota pace and device states, with a word |
| `scrim` | behind a dialog |

| Type role | Use |
|---|---|
| `title`, `heading` | screen title; card title |
| `question` | a decision's question |
| `body`, `small` | text; secondary lines |
| `action` | buttons |
| `label` | section names and status pills |
| `figure` | a large number, such as used percent |
| `machine` | ids, keys, machine and session names, in the sans |
| `code` | Markdown code in a decision's context, the only mono |
