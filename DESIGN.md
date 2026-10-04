---
name: starbridge
description: Beacon. A black, quiet screen where one amber light marks what needs you.
scheme: light-and-dark
# Every colour is a hex (#rrggbb or #rrggbbaa) so the Kotlin output can read it.
# Both schemes carry the same keys; the generator refuses a key missing from one.
# Neutrals have no hue. Amber is the icon's climber.
colors:
  light:
    bg: "#f4f4f4"
    surface: "#ffffff"
    surface2: "#ebebeb"
    line: "#e0e0e0"
    line-strong: "#c6c6c6"
    fg: "#121212"
    fg2: "#595959"
    fg3: "#8c8c8c"
    accent: "#965700"
    accent-hi: "#7a4600"
    on-accent: "#ffffff"
    accent-soft: "#9657001a"
    ok: "#595959"
    ok-soft: "#5959591a"
    warn: "#965700"
    warn-soft: "#9657001a"
    bad: "#b8322a"
    bad-soft: "#b8322a1a"
    info: "#595959"
    info-soft: "#5959591a"
    scrim: "#00000066"
  dark:
    bg: "#0c0c0c"
    surface: "#171717"
    surface2: "#232323"
    line: "#2a2a2a"
    line-strong: "#3b3b3b"
    fg: "#f1f1f1"
    fg2: "#a3a3a3"
    fg3: "#6a6a6a"
    accent: "#f5a83b"
    accent-hi: "#ffc067"
    on-accent: "#1c1100"
    accent-soft: "#f5a83b1f"
    ok: "#a3a3a3"
    ok-soft: "#a3a3a31f"
    warn: "#f5a83b"
    warn-soft: "#f5a83b1f"
    bad: "#ff6b5f"
    bad-soft: "#ff6b5f1f"
    info: "#a3a3a3"
    info-soft: "#a3a3a31f"
    scrim: "#000000b3"
# Two faces. `sans` sets everything; `mono` sets code only (the `code` role).
# Each platform binds its own files.
fonts:
  sans: "Google Sans Flex, Roboto Flex, system-ui, -apple-system, sans-serif"
  mono: "Google Sans Code, ui-monospace, SFMono-Regular, monospace"
# The Material 3 type scale, one role per job. Sizes in px (sp on Android),
# lineHeight as a multiple, letterSpacing in em.
# `tabular: true` turns on tabular figures (tnum) so numbers line up.
typography:
  title: # headline large
    font: sans
    size: 32
    weight: 500
    lineHeight: 1.25
    letterSpacing: 0
  heading: # headline small
    font: sans
    size: 24
    weight: 500
    lineHeight: 1.333
    letterSpacing: 0
  question: # title large
    font: sans
    size: 22
    weight: 500
    lineHeight: 1.273
    letterSpacing: 0
  body: # body large
    font: sans
    size: 16
    weight: 400
    lineHeight: 1.5
    letterSpacing: 0.031
  action: # title medium, the label of medium-size buttons
    font: sans
    size: 16
    weight: 500
    lineHeight: 1.5
    letterSpacing: 0.009
  small: # body medium
    font: sans
    size: 14
    weight: 400
    lineHeight: 1.429
    letterSpacing: 0.018
  figure: # headline medium, emphasized
    font: sans
    size: 28
    weight: 600
    lineHeight: 1.286
    letterSpacing: 0
    tabular: true
  machine: # body medium, tabular
    font: sans
    size: 14
    weight: 400
    lineHeight: 1.429
    letterSpacing: 0.018
    tabular: true
  label: # label large
    font: sans
    size: 14
    weight: 500
    lineHeight: 1.429
    letterSpacing: 0.007
  code:
    font: mono
    size: 14
    weight: 400
    lineHeight: 1.429
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
# The Material 3 shape scale.
radius:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 28
  pill: 999
size:
  tap: 48
  bar: 80
  rail: 240
  content: 720
  track: 10
# The web's stand-ins for Material's motion scheme; Android uses
# MotionScheme.expressive() and these only where Compose takes a duration.
motion:
  fast: 150
  state: 250
  spring: 350
---

# Starbridge design

The frontmatter above is the design system. `web/scripts/tokens.ts` turns it
into `web/src/styles/tokens.css` and `type.css`, and into
`android/app/src/main/kotlin/dev/starbridge/app/ui/theme/Tokens.kt`, so both
clients share colours, type and spacing. Change a value here, then run
`bun web/scripts/tokens.ts`; `--check` fails when an output is stale.

## The look

Direction C, "Beacon", picked on 2026-10-04 (#49, SPEC.md). Soft black and
neutral greys with no hue, large type, round cards, airy spacing. One
accent: the amber of the icon's climber, which means "needs you" and nothing
else. Everything else is black, white and grey.

Android is a flagship Material 3 Expressive app, used fully and by the
guidelines: connected button groups for a decision's options, the navigation
bar with its pill indicator (a navigation rail on wide screens), flexible top
app bars, the expressive motion scheme (springs with overshoot), progress
indicators with a gap and a stop mark for quota windows, the loading
indicator, predictive back, haptics on answer, and list and detail side by
side on wide screens. Stock components take their colours from these tokens
through the theme.

Colours on Android are a setting, "Colours": "Starbridge" (the default) uses
these tokens; "Match wallpaper" uses Material You dynamic colour for the
neutrals and Material's roles. Under either, `accent`, `on-accent`,
`accent-soft`, `ok`, `warn` and `bad` (and their `-soft` tints) stay fixed
from these tokens, so amber still means "needs you" and quota states keep
their meaning. The web has no such setting.

The web page uses the same faces and tokens with web components: list and
detail panes, hover states, keys for the options (1 to 4) and for moving
(J, K), no ripples, floating buttons or bottom bar on wide screens. It pairs
with the app without imitating Android.

Google Sans Flex sets everything a person reads, numbers included, with
tabular figures where they line up. It is the face of Google's own apps and
open source (OFL) since November 2025, so a Material app reads native in it
where Roboto reads stock. Google Sans Code is for code only: Markdown code in
a decision's context.

## Rules

- Write tokens, never a raw colour, size or radius. A component that needs a
  new primitive adds it here in the same commit and says why.
- Amber is for "needs you" only: open decisions, the recommended option (a
  filled amber button, the only filled one), and quota headroom left unused,
  which the owner treats as waste to act on. A screen at rest has no amber.
- Quota state comes with a word, never colour alone: "On pace" in grey (`ok`),
  "Will run out" in red (`bad`), "Headroom unused" in amber (`warn`). Every
  meter carries a tick where a steady pace would be now.
- An answered decision collapses to one line: the answer, the question, which
  device answered and when.
- Light and dark are peers and follow the system setting; dark is the
  default where a platform reports no preference. Every screen ships in both.
- Mobile width first. Tap targets are at least `size.tap`. Wider screens add a
  side rail (`size.rail`) and cap content at `size.content`.
- Labels are sentence case, never uppercase.
- Shapes follow the Material 3 scale: cards `radius.xl`, buttons `radius.pill`
  (round ends in a connected group, inner corners `radius.sm`), inset areas
  such as code `radius.lg`, inputs `radius.xs` on top. Cards on the dark
  ground are filled (`surface`), with no border and no shadow.
- Quota progress tracks are `size.track` thick.

## Roles

| Token | Use |
|---|---|
| `bg` | page ground |
| `surface`, `surface2` | cards and the navigation bar; inset areas, tracks, the active nav pill |
| `line`, `line-strong` | dividers; outlined buttons and inputs |
| `fg`, `fg2`, `fg3` | text; secondary text; hints, disabled, the progress stop mark |
| `accent`, `on-accent`, `accent-soft` | the beacon; text on it; its tint behind a recommended option |
| `ok`, `warn`, `bad` (+ `-soft`) | quota pace: on pace (grey), headroom unused (amber), will run out (red), always with a word |
| `info` (+ `-soft`) | neutral device states, with a word |
| `scrim` | behind a dialog |

| Type role | Material role | Use |
|---|---|---|
| `title` | headline large | screen title in the large flexible top app bar |
| `heading` | headline small | section and card titles |
| `question` | title large | a decision's question |
| `body`, `small` | body large, body medium | text; secondary lines |
| `action` | title medium | buttons |
| `label` | label large | section names and status words |
| `figure` | headline medium | a large number, such as used percent |
| `machine` | body medium | ids, keys, machine and session names, in the sans |
| `code` | | Markdown code in a decision's context, the only mono |
