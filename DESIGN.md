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
# It fills the provider's quota bars and nothing else. The generator keeps
# each colour's hue and shifts its OKLCH lightness, only as far as needed,
# until the fill reaches 3:1 against bg, surface and surface2 (the track) of
# each scheme.
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
# Two faces. `sans` sets everything; `mono` sets code only (`code`, `command`).
# Each platform binds its own files.
fonts:
  sans: "Google Sans Flex, Roboto Flex, system-ui, -apple-system, sans-serif"
  mono: "Google Sans Code, ui-monospace, SFMono-Regular, monospace"
# The type scale, one role per job, on Material 3's sizes where a role has
# one. Sizes and line heights in px (sp on Android), letterSpacing in em.
# `tabular: true` turns on tabular figures (tnum) so numbers line up.
# `compact` overrides a role on the web under 600 px wide; `wide` overrides it
# in the web's detail pane from `size.detail-wide-from`.
typography:
  hero: # the landing page's headline, web only
    font: sans
    size: 72
    weight: 500
    lineHeight: 76
    letterSpacing: -0.025
    compact: { size: 40, lineHeight: 44, letterSpacing: -0.02 }
  display: # display medium: a screen's title in Android's large top app bar
    font: sans
    size: 45
    weight: 500
    lineHeight: 52
    letterSpacing: 0
  title: # display small: a sub-screen's title on Android, a landing section's title
    font: sans
    size: 36
    weight: 500
    lineHeight: 44
    letterSpacing: 0
    compact: { size: 28, lineHeight: 36 }
  heading: # headline small: page titles and a question in the web's detail pane
    font: sans
    size: 24
    weight: 500
    lineHeight: 32
    letterSpacing: 0
    wide: { size: 30, lineHeight: 38 }
  question: # title large: a question in Android's sheet
    font: sans
    size: 22
    weight: 500
    lineHeight: 28
    letterSpacing: 0
  subtitle: # a question on an Android card, a web dialog's title
    font: sans
    size: 18
    weight: 500
    lineHeight: 24
    letterSpacing: 0
  lead: # the landing page's sentence under the headline
    font: sans
    size: 19
    weight: 400
    lineHeight: 28
    letterSpacing: 0
    compact: { size: 17, lineHeight: 26 }
  prose: # landing paragraphs
    font: sans
    size: 17
    weight: 400
    lineHeight: 26
    letterSpacing: 0
    compact: { size: 16, lineHeight: 24 }
  body: # body large
    font: sans
    size: 16
    weight: 400
    lineHeight: 24
    letterSpacing: 0
  action: # title medium: the label of large buttons
    font: sans
    size: 16
    weight: 500
    lineHeight: 24
    letterSpacing: 0
  reading: # the agent's text in the web's detail pane
    font: sans
    size: 15
    weight: 400
    lineHeight: 24
    letterSpacing: 0
    wide: { size: 17, lineHeight: 28 }
  small: # body medium
    font: sans
    size: 14
    weight: 400
    lineHeight: 20
    letterSpacing: 0
  label: # label large: buttons on the web, section names, status words
    font: sans
    size: 14
    weight: 500
    lineHeight: 20
    letterSpacing: 0
  machine: # body medium, tabular: ids, numbers, times
    font: sans
    size: 14
    weight: 400
    lineHeight: 20
    letterSpacing: 0
    tabular: true
  meta: # the web's dense rows: the meta row, secondary lines
    font: sans
    size: 13
    weight: 400
    lineHeight: 20
    letterSpacing: 0
    tabular: true
  caption: # body small: group names in a list, footnotes, navigation bar labels
    font: sans
    size: 12
    weight: 400
    lineHeight: 16
    letterSpacing: 0
  key: # label small: keyboard hints and counts in badges
    font: sans
    size: 11
    weight: 500
    lineHeight: 16
    letterSpacing: 0
  figure: # headline small, emphasized: a quota's percent on Android
    font: sans
    size: 24
    weight: 600
    lineHeight: 32
    letterSpacing: 0
    tabular: true
  code: # Markdown code in a decision's context
    font: mono
    size: 14
    weight: 400
    lineHeight: 20
    letterSpacing: 0
  command: # a permission prompt's command, where it is the content
    font: mono
    size: 18
    weight: 400
    lineHeight: 28
    letterSpacing: 0
  snippet: # a command or a session name in the web's dense rows
    font: mono
    size: 13
    weight: 400
    lineHeight: 20
    letterSpacing: 0
# px on the web, dp on Android.
spacing:
  s1: 4
  s1h: 6 # the web's dense rows: gaps inside a meta row
  s2: 8
  s2h: 10 # the web's dense rows: rail items, inline code
  s3: 12
  s4: 16
  s5: 20
  s6: 24
  s8: 32
  s10: 40
  s16: 64 # the web's page margins beside the rail
  # The landing page's larger rhythm.
  s12: 48
  s18: 72
  s20: 80
  s24: 96
  s30: 120
  s40: 160
# The Material 3 shape scale.
radius:
  xs: 4
  dense: 6 # the web's rail items, inputs and inline commands
  sm: 8
  md: 12
  lg: 16
  xl: 28
  phone: 44 # a phone's screen corners on the landing page
  pill: 999
size:
  tap: 48
  bar: 80
  bar-web: 64 # the web's bottom bar under 600 px
  top-web: 56 # the web's top bar under 600 px
  rail: 240
  list: 420 # the web inbox's list pane
  aside: 320 # the web inbox's quota windows
  pane-head: 48 # the head of each web inbox pane
  content: 720
  settings-label: 220 # the column of section names beside Settings' boxes, from 900 px
  quota-provider: 200 # the provider's column on the Quotas table
  quota-table-from: 840 # the Quotas page's own width from which it is one table
  quota-reset: 128 # the Quotas table's reset column: its longest time, "tomorrow 10:59 PM", fits
  # Quota meters. The pace tick and the overrun's red cap stand `s1` beyond
  # the track on each side; the overrun is hatched at -45°, `tick`-wide
  # stripes every `hatch`.
  track: 10 # a meter's thickness on Android
  track-dense: 6 # on the web
  tick: 2 # the pace tick on the web; Android draws it `cap` wide
  cap: 4 # the red cap where a projected overrun meets the limit
  hatch: 6
  media: 360 # the tallest an attached image shows in a decision
  media-wide: 560 # the same, in a wide detail pane
  detail-wide-from: 1000 # the web's detail pane width from which its content widens and its type steps up
  detail-wide: 1280 # the widest a wide detail pane's content runs
  page: 1200 # the landing page's width
  showcase: 1240 # the landing hero's product shot: a browser window and a phone
  browser: 1080 # the browser window in it
  shot: 316 # a phone on the landing page, its bezel included
  lead: 600 # the landing page's sentence under the headline
# The web's motion ("Motion and states" below); Android uses
# MotionScheme.expressive() and these only where Compose takes a duration.
motion:
  fast: 150 # Material's short3: hover, press, a switch, anything leaving
  state: 250 # medium1: something appearing or opening
# The one easing on the web: Material 3's emphasized decelerate, fast out of
# the gate and settling softly, so a change reads at once. Web only.
easing: "cubic-bezier(0.05, 0.7, 0.1, 1)"
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
else. Everything else is black, white and grey, except the quota bars, which
fill in each provider's lab colour.

Design v2 (2026-10-05, SPEC.md) gives each surface a job, and the owner's mockups are the source for every
screen: the landing page shows the product (direction B), the web app is a
quiet, dense control surface for any browser (A), and Android is full
Material 3 Expressive (C).

Android is a flagship Material 3 Expressive app, used fully and by the
guidelines: connected button groups for a decision's options, the navigation
bar with its pill indicator (a navigation rail on wide screens), flexible top
app bars, the expressive motion scheme (springs with overshoot), progress
indicators with a gap and a stop mark for quota windows, the loading
indicator, predictive back, haptics on answer, and list and detail side by
side on wide screens. Stock components take their colours from these tokens
through the theme.

Colours on Android are a setting, "Colours": "Starbridge" (the default) uses
these tokens; "Match wallpaper" uses Material You dynamic colour. Screens
draw neutrals and components from Material's roles, not from the tokens, and
the "Starbridge" scheme maps the tokens onto those roles (`bg` is `surface`,
`surface` is `surfaceContainer`, `surface2` is `surfaceContainerHighest` and
`secondaryContainer`, `fg` is `onSurface` and `primary`, `fg2` is
`onSurfaceVariant` and `secondary`, `line` and `line-strong` are
`outlineVariant` and `outline`). So under "Match wallpaper" every role
follows the wallpaper: grounds, cards, the navigation bar and rail, top app
bars, buttons and button groups, text fields, the selected decision,
progress tracks and loading indicators, dialogs, snackbars, the window behind
them, the splash from the next cold start (Android 13 and later) and the
notification's accent (Android 12 to 15; 16 tints notifications itself).
`info` follows as `onSurfaceVariant`, and `fg3`, which has no Material role,
is `onSurfaceVariant` at 72% over the ground.

Only these stay fixed under both settings: the amber (`accent`, `accent-hi`,
`on-accent`, `accent-soft`), the quota states (`ok`, `warn`, `bad` and their
`-soft` tints; `bad` also stands in for Material's `error`) and the provider
fills. So amber still means "needs you", quota states keep their meaning, and
a provider keeps its colour. The launcher icon keeps its own colours; its
monochrome layer lets Android draw the themed icon. A unit test checks the
fixed colours against warm, cool and low-chroma wallpapers in light and dark:
4.5:1 for text, 3:1 for fills and marks, and 3:1 for `fg3`, as the tokens'
own `fg3` reaches about 3.3:1.

The web app uses the same faces and tokens with web components, dense: a left
rail (Inbox, Quotas, Settings) that becomes a bottom bar under 600 px, list
and detail panes with the quota windows beside them, hover states, keys for
the options (1 to 4) and for moving (J, K), and no ripples or floating
buttons. Under 600 px the same structure turns comfortable: larger rows, and
a question's options and a prompt's Allow and Deny on the row. The detail
pane never sits as a strip in empty ground: from `size.detail-wide-from` wide, its content
takes 86% of the pane up to `size.detail-wide`, images grow to `size.media-wide`, and the
roles with a `wide` size step up. On the web,
"Colours" picks the theme: System (the default), Light or Dark, set as
`data-theme` on `<html>` and remembered on the device. It pairs with the app
without imitating Android.

Google Sans Flex sets everything a person reads, numbers included, with
tabular figures where they line up. It is the face of Google's own apps and
open source (OFL) since November 2025, so a Material app reads native in it
where Roboto reads stock. Google Sans Code is for code only: Markdown code in
a decision's context, a permission prompt's command and a session's name.

## Rules

- Write tokens, never a raw colour, size or radius. A component that needs a
  new primitive adds it here in the same commit and says why.
- Amber is for "needs you" only, and never fills a bar or a track. It shows
  as text with a count or a timer (a blocked item's clock, the inbox count),
  as a tint (`accent-soft`) behind a whole item that blocks an agent, as the
  kind icon of such an item, as the one filled default button, and as
  "Headroom unused", which the owner treats as waste to act on. A screen at
  rest has no amber.
- Lab colours show in one place only: a quota bar's fill. Never as text, a
  dot, a border or a container. Position keeps them apart from amber: a lab
  colour is always inside a meter's track, amber is a line of text or a tint
  around a whole item.
- There are no status or provider dots. Quota state is a word in its colour,
  never colour alone: "On pace" in grey (`ok`), "Will run out in 50 min" and
  "Ran out at 11:40" in red (`bad`), "Headroom unused" in amber (`warn`).
- Every meter carries a tick (`fg`) where a steady pace would be now. A window
  that will run out draws the use projected before its reset hatched in the
  lab colour, ending in a red cap (`bad`) at the limit; one that ran out is
  full, with the cap and no tick. Windows that will run out or ran out sort
  first on every screen while "Running out first" is on (the default).
- Quota windows sit under their provider: one heading with the provider's
  name (and the machine, when several upload), then each window as a row
  that names only the window.
- A permission prompt and a question look different. A prompt shows a
  terminal icon, the exact command in mono, Allow and Deny,
  and how long it has waited. A question shows its text as the title, then
  its options, its default (the first) filled.
- Allow covers what the owner saw. A prompt's detail shows the whole tool
  input, never the one-line summary: a command in full, else the input as
  indented JSON. Allow, by button, key or a wider grant, waits until the
  input's end has been on screen. A row carries Allow only when its input fits
  on one line of 200 characters, shown whole; otherwise only Deny, and the
  detail allows. A wider grant (this session, this project) shows its exact
  rule in mono beside its label, never only in a tooltip.
- Every inbox item is the same container (#248): on Android a filled card
  (`surface`) with no border and no shadow; on the web a box as its settings
  rows are (`surface`, a `line` border, `radius.sm`). An item that blocks an
  agent (a prompt, and a question whose agent waits on it) differs by its
  fill alone: the amber fill
  (`accent-soft` over `surface`), its kind icon in `accent`, its title at
  weight 500, and in the meta row's time slot a clock ticking m:ss in
  `accent`, weight 500. A question its agent works around keeps the plain
  card, its icon in `fg2`, its title at weight 400 and its age in the time
  slot. Kind icons sit on the card, with no tile. No line of text says which;
  screen readers get it in the item's label. Fill, weight and the clock keep
  it readable without colour.
- In One feed each item stands apart, `s2` from the next. Under a grouping's
  header (Group by machine, Group by waiting) the group's items are joined,
  and History with them: on Android a segmented group (2 dp apart, rounded
  outside as a card and `radius.xs` inside, Material 3 Expressive); on the
  web one box with hairline dividers.
- On Android, secondary buttons and the command box on a card are tonal:
  `surface2`, or `surface` on an amber card. Nothing on a card is outlined.
- Every item opens with one meta row of facts Starbridge knows: the machine's
  kind icon and name, the repo, and the time right-aligned. The agent's own
  words come below it. Details end with the session name, truncated in the
  middle, and "Open in Claude" or "Open in Codex" as text, with no logos.
- Links the agent attaches sit under "Attached by the agent", each a chip with
  "Open", the page's title (else its label) and an open-outside icon. A GitHub
  pull request or issue reads "owner/repo#123" when it has no title and leads
  with the GitHub mark.
- An answered item goes to History, collapsed by default, as one line: the
  answer, the question, which device answered and when.
- Find (the web rail's box) lists the matching open items, then "History · N"
  with the matching answered ones, answers included. A matched word is bold
  on `surface2`, never amber.
- Destructive actions are neutral text buttons on the row; only the confirm
  button in their dialog is red (`bad`).
- Copy inside the UI is labels and states only, never a sentence explaining
  the screen.
- Light and dark are peers and follow the system setting; dark is the
  default where a platform reports no preference. Every screen ships in both.
- Mobile width first. Tap targets are at least `size.tap`. Wider screens add a
  side rail (`size.rail`) and cap content at `size.content`.
- Labels are sentence case, never uppercase.
- Shapes follow the Material 3 scale: cards `radius.xl`, buttons `radius.pill`
  (round ends in a connected group, inner corners `radius.sm`), inset areas
  such as code `radius.lg`, inputs `radius.xs` on top. Android's cards are
  filled (`surface`), with no border and no shadow; its inbox cards are
  `radius.xl` with 20 dp inside, 16 dp from the screen's edges; one-line
  cards (History's rows) round at 20 dp. The web keeps its own dense shapes
  and takes none of Material's: its inbox items are `radius.sm` boxes.
- Quota tracks are `size.track` thick on Android and `size.track-dense` on
  the web.

## Motion and states (web)

Decided 2026-10-05: the web moves only where motion shows what changed,
and never makes an action wait. It follows the quiet dashboards in the
design research (Linear,
Vercel, Tailscale), where views and selections switch at once and a read row
changes in place; durations and the easing come from Material 3, so the web
and Android move alike.

- Two durations and one easing: `motion.fast` (150 ms) for hover, press, a
  switch and anything leaving; `motion.state` (250 ms) for something
  appearing or opening; `easing` for both. As CSS: `--t-fast`, `--t-state`,
  `--ease`.
- What moves: a short fade with at most 8 px of travel, and a row sliding
  to its new place when the inbox reorders it. No scale, no bounce, no
  parallax, no scroll-triggered reveals, no height animation.
- `prefers-reduced-motion: reduce` turns every transition and animation off
  (globals.css); the change still happens, at once.

| What | How |
|---|---|
| A dialog opening | fades in and rises 8 px at `state`, its scrim fades; closing is instant |
| A menu opening (the inbox's view menu) | fades in and drops 4 px at `fast`; closing is instant |
| An item opening on a phone | the detail fades in and moves 8 px from the right at `state`; Back is instant |
| History expanding | its chevron turns at `fast`, its rows fade in at `state`; collapsing is instant |
| An item arriving while the page is open | fades in at `state`; items present at load don't animate |
| An answered item leaving | fades out at `fast`, then the list closes up without moving |
| A row changing place (a question starts or stops waiting) | slides to its new place at `state`; its colours change at `state` |
| A status line ("Pixel joined.", "Refused …") | fades in at `state`, stays until the next action |
| Pressing a button | its fill steps one tone darker while pressed; no scale, no ripple |
| A switch | the knob slides at `fast` |
| Dragging a row by its handle (the Quotas table's providers, Settings' providers) | the row follows the pointer, mouse, pen or touch, with no transition; the rows it passes slide aside at `state`; on release it settles into its place at `state`, landing with the rows it passed; Escape puts it back. The arrow keys, Home and End on a focused handle move it at once |
| The theme changing | at once: transitions are off for that frame, so nothing fades at its own pace |

Never animated: page and tab changes, moving the selection (J, K or a click),
the wide detail pane's content, quota bars and numbers (they show their
value, not a count-up), the landing page while scrolling, and anything during
first paint.

**Hover.** Only where a pointer hovers (`@media (hover: hover)`), so phones
keep no stuck hover. Rows, ghost and outlined buttons take `surface2`; text
links and the rail go from `fg2` to `fg`; filled buttons go one tone lighter
(`fg2`, `accent-hi`). At `fast`.

**Focus.** Keyboard focus only (`:focus-visible`): a 2 px `fg` ring, 2 px
out, following the element's corners. Not amber, which means "needs you".
Inputs show focus by their own border instead.

**Loading.** Nothing flashes blank, and nothing shows up only to be
replaced. While boot decides which screen to show, the page is plain `bg`.
A part that loads after the page shows a skeleton in its own shape:
`surface2` blocks the size of the rows they stand for, which fade in after
200 ms (so a fast load shows none) and pulse gently until the data lands;
under reduced motion they stay still. Buttons that wait say so in their
label ("Creating the keys…") and keep their width.

**Scrollbars.** The page and every scrolling pane keep their scrollbar's
gutter (`scrollbar-gutter: stable`), so content never shifts when a list
grows past the screen. Scrollbars are thin, a `line-strong` thumb on a
transparent track, in both themes; overlay scrollbars (phones, macOS) stay
as the system draws them.

**Secondary pages** (Settings, Add a device, first run, legal, not found,
error) share one rhythm: the page title in `heading`, sections `s10` apart
(`s8` on phones), each with its name in `action` and its rows in one box
(`surface`, `line` border, `radius.sm`, hairline dividers, rows at least
`size.tap` tall). An empty section says what is missing in one line of
`fg2`, with its action if it has one. First-run, not found and error pages
use the first-run frame: the brand top left, one 400 px column, legal links
at the foot. From 900 px, Settings sets each section's name in a column
(`size.settings-label`) beside its box, and the rows keep `size.content`.

**Quotas page** (web). Narrower, a card per provider, as on Android.
Once the page itself is `size.quota-table-from` wide (a window about 1210 px wide,
with the rail), one table up to `size.page` wide, as dense as the inbox: the
provider (and its machine) in a column of `size.quota-provider`, then one
line per window with its name, meter, figure, state and reset in columns. A
handle before the provider's name reorders providers there; providers that
lead while "Running out first" is on keep their place, with a pin in the
handle's place whose tap or click says why, and a provider with a leading
row is a barrier the others don't cross. Narrow screens reorder
in Settings.

## Provider colours

Each quota bar fills in its provider's lab colour: an identity mark, never a
meaning. Status words keep the quota states, so pace never depends on a brand
colour, and a lab colour near amber (claude, mistral) never reads as "needs
you", because it only ever sits inside a track. The colours are CodexBar's,
keyed by its provider id, with no logos. The generator emits each one twice,
for light and dark: unchanged when it already reaches 3:1 against `bg`,
`surface` and `surface2`, otherwise moved in OKLCH lightness, with hue kept,
just far enough to reach it. Web: `--provider-<id>`; Android:
`LightProviders` and `DarkProviders`. A provider without a colour fills in
`fg3`.

## Icons

The web draws its own icon set to the mark: 24-unit grid, 1.75 strokes,
round caps and joins, no fills. Android uses Material Symbols Rounded tuned to
Google Sans Flex; a native iOS app, if one comes, would use SF Symbols. Every
platform has the same icons by job: laptop, desktop, server and cloud (a
machine's kind), permission prompt, question, run, quota, history, settings,
devices, open in the agent, waiting, inbox, send.

## The mark

The mark is a space elevator on a 108-unit canvas (the Android adaptive
icon grid; the visible area is the central 72): a planet's edge (a circle at
54,148, radius 80) and a tether (x 51.75 to 56.25, from the top edge down
into the planet) in `fg` dark, and one amber climber, a capsule 11 wide and
20 tall at 48.5,34, in `accent` dark. Where the mark has a ground, it is `bg`
dark in both schemes, and the climber is the only amber. Single-colour uses (themed icon,
notification icon) draw all three shapes in one colour.

| Where | File |
|---|---|
| Android launcher | `res/mipmap-anydpi/ic_launcher*.xml`, layers in `res/drawable/ic_launcher_*.xml` |
| Android notification | `res/drawable/ic_notification.xml` (white, 24 dp) |
| Web tab icon | `web/src/app/icon.svg` |
| Web favicon and install icons | `web/src/app/favicon.ico` (16, 32, 48 px), `apple-icon.png` (180 px), `web/public/icon-*.png`, `manifest.ts` |

The tab icon is the mark as the page's rail draws it, with no ground, in
`fg` and `accent` of the system's scheme, with a thin halo in the other
scheme's `fg` so it stays legible on a tab strip that does not follow the
system. The other web icons stand on the launcher's ground,
since a home screen, or a browser that skips the SVG, shows them on any
colour; `node web/scripts/icons.ts` renders them.

The product name has no wordmark: it is "Starbridge" in the sans, weight 500. Beside the mark,
the name stands on the mark's ground: its baseline sits on the mark's bottom
edge (y 90 of the grid, where the planet's edge ends), and its "g" descends
below. The gap is 0.4 × the mark's size (`s2` at 20 px). The web aligns them
with `align-items: baseline`, since a mark's synthesized baseline is its
bottom edge; Android with `alignBy` (the mark at its height, the name at
`LastBaseline`), in `ui/Lockup.kt`. The mark alone (favicon, app and notification icons, the
phone top bar) is unchanged.

## Roles

| Token | Use |
|---|---|
| `bg` | page ground |
| `surface`, `surface2` | cards, the rail and the navigation bar; inset areas, tracks, the selected row, the active nav pill |
| `line`, `line-strong` | dividers; outlined buttons and inputs |
| `fg`, `fg2`, `fg3` | text and the pace tick; secondary text; hints, disabled, the progress stop mark |
| `accent`, `on-accent`, `accent-soft` | the beacon; text on it; its tint behind an item or a prompt's tile |
| `ok`, `warn`, `bad` (+ `-soft`) | quota pace as a word: on pace (grey), headroom unused (amber), will run out or ran out (red, also the overrun's cap and a destructive confirm) |
| `info` (+ `-soft`) | neutral device states, with a word |
| `providers` | a quota bar's fill and its hatched overrun |
| `scrim` | behind a dialog |

| Type role | Material role | Use |
|---|---|---|
| `hero` | | the landing page's headline |
| `display` | display medium | a screen's title in Android's large top app bar |
| `title` | display small | a sub-screen's title on Android, a landing section's title |
| `heading` | headline small | web page titles, a question in the web's detail pane, empty states |
| `question` | title large | a question in Android's sheet |
| `subtitle` | | a question on an Android card, a web dialog's title |
| `lead`, `prose` | | the landing page's text |
| `body`, `small` | body large, body medium | text; secondary lines |
| `action` | title medium | large buttons |
| `reading` | | the agent's text in the web's detail pane |
| `label` | label large | web buttons, section names, status words |
| `machine` | body medium | ids, numbers and times, in the sans |
| `meta` | | the web's dense rows: meta row, secondary lines |
| `caption` | body small | group names in a list, footnotes, navigation bar labels |
| `key` | label small | keyboard hints, counts in badges |
| `figure` | headline small | a large number, such as used percent |
| `code`, `command`, `snippet` | | Markdown code; a permission prompt's command; a command or session name in a dense row; the only mono |
