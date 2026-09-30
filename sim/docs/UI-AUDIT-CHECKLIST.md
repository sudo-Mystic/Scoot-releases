# UI Audit Checklist - Scoot Simulator Cockpit

Worker W14 (ui-polish). Applies to every panel in `sim/src/ui/*.js` and
every rule in `sim/src/styles/*.css`. Audit-only reads anything under
`sim/src/` engine/relay/transport (logic is out of scope; touch visuals only).

Design read and dials are declared once below and re-verified per panel.

## 0. DESIGN READ AND DIALS (declared once)

**Design Read:** Reading this as: a hidden developer instrument cockpit for a
single technical user, with a dark-tech instrument language, leaning toward
vanilla JS + native CSS custom properties + canvas (vite build, no framework).

**Dials:**
- `DESIGN_VARIANCE: 4` - predictable instrument grid, asymmetric only where the
  panel's function demands it (cluster left, controls right). No decorative
  asymmetry.
- `MOTION_INTENSITY: 3` - static except live value updates and status LEDs; the
  cluster canvas is functional motion (a real render of real data), not
  decoration. No scroll animations, no marquees, no parallax.
- `VISUAL_DENSITY: 9` - cockpit. 1px dividers, mono numerals, plain layout,
  generic card containers banned (skill Section 4.4). One panel label per
  section max; spacing over boxes.

Because this is an instrument, not a landing page, the following skill rules
are adapted (not dropped): hero rules (4.7 hero sections) are N/A; eyebrow
restraint becomes panel-label restraint; "no fake screenshots" is satisfied by
construction (the cluster is a real functional canvas render); icon rules
apply to status glyphs; dark-mode protocol collapses to the single locked
dark theme (no per-section theme flips).

## 1. ACCENT-COLOR LOCK VERIFICATION

The locked accent is volt lime, defined once in
`sim/src/styles/tokens.css`:
- `--accent: #c8ff00` (primary)
- `--accent-dim: #8fae00` (muted secondary marks)
- `--accent-ink: #141a00` (text placed on accent fills)

Semantic status colors are NOT accents and may appear only where they carry
real semantic state: `--ok: #7dff6a`, `--warn: #ffc24a`, `--bad: #ff5d5d`.

- [ ] Mechanical: `grep -rnE "#[0-9a-fA-F]{3,8}" sim/src/ui sim/src/styles`
  returns NO hex literals. All color goes through `var(--...)` from tokens.css.
  (tokens.css itself may declare hexes; nothing else may.)
- [ ] Mechanical: `grep -rniE "accent|lime" sim/src/ui` shows every accent use
  referencing `var(--accent)` or `var(--accent-dim)`. No `rgb(200,255,0)`
  rewrites, no inline `style="color:#c8ff00"`.
- [ ] No second accent anywhere: no blue/teal/pink/orange decorative color on
  buttons, badges, focus rings, scrollbars, or chart lines. Status colors only
  for real state (connected/fault/warning LEDs).
- [ ] The AI-purple ban holds: no violet/blue gradients, no neon outer glows
  (tinted inner shadows or 1px borders only).

## 2. TYPOGRAPHY RULES

- [ ] No Inter anywhere: `grep -rni "inter" sim/src` returns nothing. The UI
  sans is `--font-ui` (system-ui stack). No other display font family is
  introduced without W6 agreement.
- [ ] Serif discipline: no serif font anywhere. Italics, if used for emphasis,
  use the same family with `leading >= 1.1` clearance for descenders.
- [ ] ALL numerals are mono: values, units readouts, timestamps, counters,
  slider readouts, canvas HUD text. The `.num` / `[data-num]` convention in
  app.css covers it; canvas text uses `--font-mono` (set `ctx.font` explicitly,
  canvas does not inherit CSS).
- [ ] `font-variant-numeric: tabular-nums` on every numeric readout so live
  values do not jitter horizontally when digits change.
- [ ] One type register: short functional instrument labels
  ("THROTTLE", "BATTERY"). No editorial prose, no marketing copy, no mixed
  registers on the same panel.

## 3. NO-AI-TELL SWEEP (cockpit-adapted)

- [ ] No centered-hero patterns, no decorative text strips, no scroll cues, no
  version footers, no locale/weather strips (the skill's 9.F tells are all
  banned; a single build/hash line in the status bar is instrument data, not
  decoration, and stays one line).
- [ ] Eyebrow/panel-label restraint: at most ONE small-caps mono label per
  panel section. No `001 /`, `00 -` section numbering, no
  "Stage 1 / Step 1" generic step labels in the scenarios UI (verb-noun
  labels only: "Cold start", "Drop link").
- [ ] Middle-dot rationed: max 1 per line in status metadata strips; prefer
  hairline dividers or columns between fields.
- [ ] No decorative status dots: LED dots appear ONLY for real semantic state
  (link up/down, fault latched). Never before nav items, list rows, or badges.
- [ ] No filler verbs in labels ("Seamless", "Next-Gen", "Smart"). Concrete
  verbs only ("Connect", "Start trip", "Latch fault").
- [ ] No fake-precise numbers presented as instrument data without a source;
  simulator fixtures are fine if they are clearly simulator inputs, not fake
  measured values.
- [ ] No crosshair/hairline decorative grid lines: 1px dividers only to
  separate real content groups (DENSITY 9 rule).
- [ ] No hand-rolled SVG icons for status glyphs; if icons are needed, one
  library per project, consistent stroke width. Simple geometric LED dots and
  cluster gauges drawn in canvas are instrument rendering, not icons.

## 4. COPY SELF-AUDIT (per visible string)

For every visible string on each panel (labels, button text, placeholders,
helper text, error text, toasts, canvas HUD text, empty states):

- [ ] Grammatically complete and unambiguous; unclear referents rewritten as
  plain functional sentences.
- [ ] No AI-poetic labels: "Field notes", "Currently on the bench",
  "Quietly in use" family all banned. Plain functional labels.
- [ ] Button labels: 1-3 words, verb-first, single line at any width
  ("Reconnect", "Latch fault", "Clear trip"). No CTA wrap.
- [ ] No duplicate intent: one label per action across the cockpit
  ("Disconnect" and "Drop link" on the same panel = fail, pick one).
- [ ] Empty states are functional: what is empty + how to populate
  ("No trip data yet. Start a trip from the control deck."). No jokes, no
  filler.
- [ ] Error text names the problem and the recovery, inline near the control,
  not only as a transient toast.

## 5. BUTTON / INPUT / CONTRAST CHECKS

- [ ] Button contrast: every button label readable against its background.
  WCAG AA 4.5:1 minimum for body-size text. Volt lime (`#c8ff00`) fills take
  `--accent-ink` (`#141a00`) text, never white.
- [ ] Ghost/outline buttons carry a real border or backdrop; no invisible
  label-on-background.
- [ ] `:hover` gives feedback, `:active` gives a tactile push
  (`scale(0.98)` or translate), `:focus-visible` shows the accent focus ring.
  Focus rings must be visible against the dark background.
- [ ] Form inputs: labels above inputs, helper text present in markup where
  needed, error text below the input. No placeholder-as-label, ever.
- [ ] Placeholder text, helper text, and disabled-state text all pass 4.5:1
  against their background (check `--text-faint #5c6349` on `#070806`: if it
  fails, brighten to `--text-dim` for functional text and keep faint for
  purely decorative marks).
- [ ] Disabled buttons look disabled AND say why on hover (title attr) or are
  removed; no dead-looking-but-clickable controls.
- [ ] Touch targets: minimum 32px height for dense cockpit controls, 40px+
  for primary actions. No 16px-tall click targets.

## 6. MOBILE <768px STACKING (explicit per panel)

Asymmetric layouts MUST collapse to a strict single column below 768px
(skill Section 7 MOBILE OVERRIDE). For each panel:

- [ ] Declare the <768px fallback explicitly: `grid-template-columns: 1fr`,
  full-width controls, `px-4` gutters. No "the grid will handle it"
  assumptions.
- [ ] Cluster canvas: scales to viewport width, keeps aspect ratio, HUD text
  remains legible (no sub-9px rendered text). If it cannot fit, it gets a
  horizontal scroll region or a simplified mobile readout, explicitly chosen.
- [ ] Control deck: sliders/knobs keep 40px+ touch targets on mobile; no
  hover-only interactions (hover tooltips get a tap equivalent).
- [ ] Telemetry lab tables/log streams: wrap or scroll horizontally inside
  their panel, never overflow the viewport body.
- [ ] Topbar (48px) and status bar (28px) stay on one line; labels condense or
  collapse to icons, never wrap to two lines.
- [ ] Test at 360px width: no horizontal page scroll, no clipped controls.

## 7. PREFERS-REDUCED-MOTION

MOTION_INTENSITY is 3, so this is a light gate, but it is mandatory:

- [ ] `prefers-reduced-motion: reduce` disables: LED blink/pulse animations,
  any CSS transitions beyond instant state changes, canvas smoothing
  (render discrete steps instead of eased interpolation if easing is used).
- [ ] Live values still update (data is not motion); only the animation of
  the update changes.
- [ ] Mechanical: every `@keyframes` and every `transition` in styles, plus
  any rAF-driven easing in ui JS, has a reduced-motion path. `grep -rn
  "keyframes\|transition" sim/src/styles` and account for each hit.
- [ ] No `window.addEventListener("scroll")` anywhere (hard ban); rAF loops
  touch canvas only, never React-style state churn (this codebase is vanilla
  JS: keep render functions idempotent and cheap).

## 8. NO EM DASHES, NO EMOJIS

- [ ] Mechanical: `grep -rn "—" sim/src/ui sim/src/styles` returns nothing.
  `grep -rn "–" sim/src/ui sim/src/styles` returns nothing (en dash also
  banned as separator; date/number ranges use the hyphen `-`).
- [ ] Rewrite rule: two sentences with a period, or a comma, or parentheses,
  or a colon. Never a dash used as a design flourish.
- [ ] Mechanical: no emoji codepoints in JS, CSS, or HTML strings
  (`grep -rP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" sim/src/ui`).
  Status glyphs are text/LED dots, not emoji.
- [ ] No ASCII-art emoji substitutes used as decoration (`(>_<)`, `¯\_(ツ)_/¯`).

## 9. MONO NUMERALS (cross-cutting)

Covered in Section 2, re-checked per panel because panels render their own
values:

- [ ] Every numeric readout on the panel (including canvas-drawn text and
  dynamically injected DOM) uses `--font-mono` + `tabular-nums`.
- [ ] Units are text-dim, values are text-bright; the value, not the unit,
  carries visual weight.
- [ ] Live values do not cause layout shift when digits change (fixed-width
  containers or tabular numerals; verify by watching a fast-changing value).

## 10. LAYOUT DISCIPLINE (DENSITY 9)

- [ ] No card soup: panels are separated by 1px `--line` dividers and spacing,
  not nested rounded boxes. Generic card containers banned at DENSITY > 7.
- [ ] Shape lock: `--radius: 6px` everywhere. No pill buttons next to square
  panels, no mixed radii without a documented rule.
- [ ] Theme lock: single dark theme. No panel inverts to light, no warm-paper
  section, no pure `#000000` backgrounds (base is `#0b0d08`).
- [ ] Z-index restraint: use only the documented scale (`--z-canvas: 1`,
  `--z-panel: 10`, `--z-overlay: 50`, `--z-toast: 60`). No arbitrary z values.
- [ ] Viewport stability: shell uses `min-h-[100dvh]`-equivalent (`100dvh`
  in app.css), never `100vh`/`h-screen` patterns that jump on mobile.
- [ ] Content density sane: telemetry streams cap visible rows (virtualize or
  cap + "show more"); no unbounded DOM growth from live logs.

## 11. PER-PANEL PASS LOG

For each panel (`cluster`, `controls`, `telemetry`, `scenarios`, plus shell
topbar/statusbar), record: panel file, checklist sections applied, issues
found, fixes made, and the mechanical grep results. Findings go to
`sim/docs/UI-AUDIT.md` in Phase 2.

## PHASE 2 RULES (do not start until the go message)

- Fix directly in `sim/src/ui/*.js` and `sim/src/styles/*.css` only.
- Keep each panel's `mount()` API stable (same signature, same mount target).
- Do not touch engine/relay/transport logic. Do not git commit.
- Run `npm run build` in `sim/` and confirm exit 0.
- Write findings to `sim/docs/UI-AUDIT.md`: per panel, what changed and why.
- Report back: UI-AUDIT.md path + build result.
