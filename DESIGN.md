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
# Each AI lab's colour, keyed by CodexBar's provider id: the `color` of its
# ProviderBranding in CodexBar's Sources/CodexBarCore/Providers (4685c35).
# It marks the provider as a dot before its name and nothing else. The
# generator keeps each colour's hue and shifts its OKLCH lightness, only as
# far as needed, until the dot reaches 3:1 against bg, surface and surface2
# of each scheme.
providers:
  abacus: "#38bdf8" # Abacus AI
  aiand: "#e25c2b" # ai&
  aixy: "#123650" # Aixy
  alibaba: "#ff6a00" # Alibaba Coding Plan
  alibabatokenplan: "#ff6a00" # Alibaba Token Plan
  amp: "#dc2626" # Amp
  antigravity: "#60ba7e" # Antigravity
  atlascloud: "#5975f5" # Atlas Cloud
  augment: "#6366f1" # Augment
  azureopenai: "#0078d4" # Azure OpenAI
  bedrock: "#ff9900" # AWS Bedrock
  bifrost: "#33c09e" # Bifrost
  chutes: "#3184ff" # Chutes
  claude: "#cc7c5e" # Claude
  clawrouter: "#596ef6" # ClawRouter
  clinepass: "#61a3fa" # ClinePass
  coderabbit: "#ff5c35" # CodeRabbit
  codebuff: "#44ff00" # Codebuff
  codex: "#49a3b0" # Codex
  commandcode: "#a04dfd" # Command Code
  copilot: "#a855f7" # Copilot
  cursor: "#00bfa5" # Cursor
  deepinfra: "#2a3275" # DeepInfra
  deepseek: "#527df0" # DeepSeek
  deepgram: "#6467f2" # Deepgram
  devpass: "#2563eb" # DevPass
  devin: "#46b482" # Devin
  doubao: "#3370ff" # Doubao
  elevenlabs: "#ebebe6" # ElevenLabs
  factory: "#ff6b35" # Droid
  fireworks: "#f25b1c" # Fireworks
  gemini: "#ab87ea" # Gemini
  gitkraken: "#179287" # GitKraken AI
  grok: "#10a37f" # Grok
  groq: "#f56844" # Groq
  helmcode: "#4934e1" # Helmcode
  huggingface: "#ffd21e" # Hugging Face
  hyper: "#ff60ff" # Charm Hyper
  ibmbob: "#0e61fa" # IBM Bob
  jetbrains: "#ff3399" # JetBrains AI
  kilo: "#f27027" # Kilo
  kimi: "#fe603c" # Kimi
  kiro: "#ff9900" # Kiro
  llmman: "#6cc5b0" # llmman
  llmproxy: "#24b47e" # LLM Proxy
  litellm: "#4c89f0" # LiteLLM
  longcat: "#ffd100" # LongCat
  manus: "#34322d" # Manus
  mimo: "#ff6900" # Xiaomi MiMo
  minimax: "#fe603c" # MiniMax
  mistral: "#ff500f" # Mistral
  moonshot: "#205deb" # Moonshot
  muse: "#0668e1" # Muse Code
  neuralwatt: "#38d98c" # Neuralwatt
  notion: "#337ea9" # Notion AI
  nous: "#d6a55c" # Nous Portal
  ollama: "#888888" # Ollama
  openai: "#0f826e" # OpenAI
  opencode: "#3b82f6" # OpenCode
  opencodego: "#3b82f6" # OpenCode Go
  openrouter: "#6467f2" # OpenRouter
  perplexity: "#20b2aa" # Perplexity
  pi: "#7c3aed" # Pi
  poe: "#5d5cde" # Poe
  qoder: "#10b981" # Qoder
  qwencloud: "#615ced" # Qwen Cloud
  raycast: "#ff6363" # Raycast
  replicate: "#000000" # Replicate
  sakana: "#2975db" # Sakana AI
  stepfun: "#2196f2" # StepFun
  sub2api: "#2dc6d8" # sub2api
  synthetic: "#141414" # Synthetic
  t3chat: "#f56647" # T3 Chat
  typesafe: "#111111" # TypeSafe
  v0: "#111111" # v0
  venice: "#3399ff" # Venice
  vercel: "#ffffff" # Vercel AI Gateway
  vertexai: "#4285f4" # Vertex AI
  warp: "#938bb4" # Warp
  wayfinder: "#10a37f" # Wayfinder
  windsurf: "#34e8bb" # Windsurf
  xai: "#8e8e93" # xAI
  xkiro: "#52c99b" # xKiro
  zai: "#e85a6a" # z.ai
  zed: "#084eff" # Zed
  zenmux: "#6c5ce7" # ZenMux
  zoommate: "#0b5cff" # ZoomMate
# Two faces. `sans` sets everything; `mono` sets code only (the `code` role).
# Each platform binds its own files.
fonts:
  sans: "Google Sans Flex, Roboto Flex, system-ui, -apple-system, sans-serif"
  mono: "Google Sans Code, ui-monospace, SFMono-Regular, monospace"
# The Material 3 type scale, one role per job. Sizes in px (sp on Android),
# lineHeight as a multiple, letterSpacing in em.
# `tabular: true` turns on tabular figures (tnum) so numbers line up.
typography:
  display: # display medium, the landing page's one headline
    font: sans
    size: 45
    weight: 500
    lineHeight: 1.1556
    letterSpacing: 0
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
  media: 360 # the tallest an attached image shows in a decision
  page: 1040 # the landing page's width, three screenshots side by side
  shot: 320 # the widest a screenshot shows on the landing page
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
these tokens; "Match wallpaper" uses Material You dynamic colour. The
web has no such setting. Screens draw neutrals and components from
Material's roles, not from the tokens, and the "Starbridge" scheme maps the
tokens onto those roles (`bg` is `surface`, `surface` is `surfaceContainer`,
`surface2` is `surfaceContainerHighest` and `secondaryContainer`, `fg` is
`onSurface` and `primary`, `fg2` is `onSurfaceVariant` and `secondary`, `line`
and `line-strong` are `outlineVariant` and `outline`). So under "Match
wallpaper" every role follows the wallpaper: grounds, cards, the navigation
bar and rail, top app bars, buttons and button groups, text fields, the
selected decision, progress tracks and loading indicators, dialogs,
snackbars, the window behind them, the splash from the next cold start
(Android 13 and later) and the notification's accent (Android 12 to 15; 16
tints notifications itself). `info` follows as `onSurfaceVariant`, and `fg3`,
which has no Material role, is `onSurfaceVariant` at 72% over the ground.

Only these stay fixed under both settings: the amber (`accent`, `accent-hi`,
`on-accent`, `accent-soft`), the quota states (`ok`, `warn`, `bad` and their
`-soft` tints; `bad` also stands in for Material's `error`) and the provider
dots. So amber still means "needs you", quota states keep their meaning, and
a provider keeps its colour. The launcher icon keeps its own colours; its
monochrome layer lets Android draw the themed icon. A unit test checks the
fixed colours against warm, cool and low-chroma wallpapers in light and dark:
4.5:1 for text, 3:1 for dots and marks, and 3:1 for `fg3`, as the tokens' own
`fg3` reaches about 3.3:1.

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

## Provider colours

Each quota card puts a dot in its provider's lab colour before the name:
an identity mark, never a meaning. Meters and status words keep the quota
states, so pace never depends on a brand colour. The colours are CodexBar's,
keyed by its provider id, with no logos. The generator emits each one twice,
for light and dark: unchanged when it already reaches 3:1 against `bg`,
`surface` and `surface2`, otherwise moved in OKLCH lightness, with hue kept,
just far enough to reach it. Web: `--provider-<id>`; Android: `LightProviders`
and `DarkProviders`. A provider without a colour gets a `fg3` dot.

## Icon

The mark is a space elevator on a 108-unit canvas (the Android adaptive
icon grid; the visible area is the central 72): a planet's edge (a circle at
54,148, radius 80) and a tether (x 51.75 to 56.25, from the top edge down
into the planet) in `fg` dark, and one amber climber, a capsule 11 wide and
20 tall at 48.5,34, in `accent` dark. The ground is `bg` dark in both
schemes, and the climber is the only amber. Single-colour uses (themed icon,
notification icon) draw all three shapes in one colour.

| Where | File |
|---|---|
| Android launcher | `res/mipmap-anydpi/ic_launcher*.xml`, layers in `res/drawable/ic_launcher_*.xml` |
| Android notification | `res/drawable/ic_notification.xml` (white, 24 dp) |
| Web favicon | `web/src/app/icon.svg`, `favicon.ico` (16, 32, 48 px) |
| Web install icons | `web/src/app/apple-icon.png` (180 px), `web/public/icon-*.png`, `manifest.ts` |

The PNG and ICO files are rendered from the SVG; redraw them when the mark
changes.

The product name has no wordmark: it is "Starbridge" in the sans, `title`
weight.

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
| `providers` | a dot before a provider's name on quota cards, its lab's colour |
| `scrim` | behind a dialog |

| Type role | Material role | Use |
|---|---|---|
| `display` | display medium | the landing page's headline, web only |
| `title` | headline large | screen title in the large flexible top app bar |
| `heading` | headline small | section and card titles |
| `question` | title large | a decision's question |
| `body`, `small` | body large, body medium | text; secondary lines |
| `action` | title medium | buttons |
| `label` | label large | section names and status words |
| `figure` | headline medium | a large number, such as used percent |
| `machine` | body medium | ids, keys, machine and session names, in the sans |
| `code` | | Markdown code in a decision's context, the only mono |
