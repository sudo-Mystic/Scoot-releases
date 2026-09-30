# UI Audit Findings, Phase 2 (W14-polish)

Date: 2026-09-30. Scope: `sim/src/ui/*.js`, `sim/src/styles/*.css`.
`mount(rootEl, ctx)` signatures kept stable everywhere. No changes to
engine/, bridge/, transport.js logic, or index.html. No commits.

Build: `npm run build` in `sim/` exits 0 (vite 5.4.21, 6 modules, 602 ms).

## Mechanical grep results (all clean after fixes)

- Hex literals in `src/ui` + `src/styles` (excluding tokens.css): none.
- Em dash / en dash in ui/styles: none. Emoji codepoints: none.
- "inter" font: none (hits were only `pointer`/`setInterval` substrings).
- `scroll` listeners in ui: none. z-index: only the documented scale vars.
- Accent references: every accent use is `var(--accent)` / `var(--accent-dim)`;
  no `rgb(200,255,0)` rewrites, no inline hex styles.
- Middle dots, section numbering (`001 /`, `Step 1`), color words
  (white/black): none.
- `prefers-reduced-motion`: every keyframes/transition in styles is accounted
  (led-blink and labpulse gated to `no-preference`; the global reduce block
  in app.css kills all transitions/animations; canvas blinking now has a
  code path, see cluster below; scenarios bar-fill transition has an explicit
  reduce rule too).

## Panel: lab (`src/ui/lab.js`)

Issues found:
1. Accent lock broken. The injected stylesheet defined its own palette:
   `--lab-volt: var(--volt-lime, var(--volt, #c6ff4a))` (a stray
   near-lime, not the locked `#c8ff00`) plus six more hex literals and two
   `rgba()` washes of the stray hue for row hover/pin states. The header
   comment still said tokens.css was "future".
2. Duplicate panel label: the panel-head from the shell already says
   "Telemetry lab"; the lab rendered its own "TELEMETRY LAB" title.
3. `.lab-btn` touch target ~27 px tall (min is 32 px for dense controls).
4. Font stack was a hard-coded mono list instead of `var(--font-mono)`.
5. Container radius was 8 px against the locked `--radius: 6px`.

Fixes: all `--lab-*` aliases now map to tokens.css variables
(`--lab-volt: var(--accent)`, surfaces/text/status to the matching tokens);
the rgba washes became `color-mix(in srgb, var(--accent) N%, transparent)`
and the same for warn; radius uses `var(--radius)`; font is
`var(--font-mono)`; the inner "TELEMETRY LAB" title span and its CSS rule
were removed (the LIVE/PAUSE/CLEAR/INJECT row stays); `.lab-btn` gained
`min-height: 32px`; header comment updated to name tokens.css as the source.

Copy kept as-is: it was already functional ("Observe-only.", "TEST FAULT
injected (kind: ...) via ...", the two empty states name what is empty and
how to populate). Buttons are 1-3 words, verb-first. Table scrolls
horizontally inside the panel on mobile; the lab grid already collapses at
860 px; the head wraps.

## Panel: scenarios (`src/ui/scenarios.js`)

Issues found:
1. Card soup: five nested `.card` boxes (bg-raise + border + radius),
   banned at DENSITY 9.
2. Duplicate label: inner h3 "Scenarios" duplicated the shell panel-head.
3. Button register mismatch: buttons used `var(--font-ui)` 13 px sentence
   case while the rest of the cockpit uses mono uppercase buttons.
4. `.meta` used `--text-faint` (3.1:1 on the base, fails 4.5:1).
5. Buttons ~29 px tall, no mobile 40 px rule; no reduced-motion rule for
   the progress-bar transition; file input had no accessible label.

Fixes: `.card` is now a divider section (`padding: 12px 0`, 1 px
`var(--line)` top border between siblings, no background/border/radius);
the "Scenarios" h3 was removed (panel-head covers it); buttons restyled to
the cockpit register (mono 11 px, uppercase, letter-spacing, 32 px
min-height, `:hover` border feedback, `:active` scale(0.98),
`:focus-visible` accent ring, accent primary / bad danger); `.meta` is now
`--text-dim` (7.2:1); buttons and the file input go to 40 px under 768 px;
the bar-fill transition has an explicit reduce rule; the file input got
`aria-label="Recording file to replay"`.

Copy kept: the engine-missing banner, status lines, and error text all name
the problem and the recovery ("No app-to-simulator frames in this file,
nothing to replay."). No filler verbs, no AI-poetic labels.

## Panel: cluster (`src/ui/cluster.js`)

Issues found:
1. `readTokens()` carried 13 hex literal fallbacks, tripping the accent
   mechanical gate.
2. The unknown-maneuver branch hard-coded `ui-monospace, Menlo, Consolas,
   monospace` instead of the token font (canvas does not inherit CSS).
3. `prefers-reduced-motion` had no canvas path: fuel-gauge flash, the
   "INCOMING CALL" blink, and the "HUD LINK LOST" blink animated regardless.
4. Small functional canvas labels (FUEL, ENG, ODO, NAVIGATION, MESSAGE,
   MEDIA, NO LINK, NET, char counts) used text-faint at ~3.1:1.

Fixes: token fallbacks removed (values resolve from tokens.css, which the
shell imports before mount; a missing token degrades to the canvas default
rather than a second hard-coded palette, so the hex grep stays empty);
`drawManeuver` now takes `T` and uses `T.mono`; a `REDUCED` flag from
`matchMedia` is threaded through the draw args and the three blinks render
steady-on instead of flashing (live values still update); the functional
canvas labels moved to text-dim (~7.2:1). The deliberate stale-state
dimming in the nav screen was left alone.

Mobile: the canvas scales to viewport width via ResizeObserver; under
768 px the mount region now scrolls horizontally with a 440 px minimum
canvas width, an explicit choice so HUD text never renders below 9 px.

## Panel: controls (`src/ui/controls.js`) + `src/styles/controls.css`

Connection section (reworked, focus area):
1. Section note "bridge link to the phone" was vague; now "phone app via
   bridge".
2. Phone row honesty: the old `phoneLabel()` branched on `bleSeen` /
   `bleSupported` flags, which could show "Phone: waiting for bridge" while
   the bridge was up, or "No phone" while the bridge was down. Reworked to
   derive strictly from real state: "Phone app connected" when the BLE link
   is up; "Phone: waiting for bridge" only while the bridge itself is down;
   "Phone: not connected" when the bridge is up but no phone has linked.
   The bridge transport fires `on('ble')` with current state on subscribe,
   so the row initializes honestly; the old-transport `peer` fallback is
   kept. The now-unused `bleSeen`/`bleSupported` flags were removed.
3. Caption rewritten in plain words: "The phone app pairs over Bluetooth
   to the bridge on this machine, the way it pairs with the real cluster.
   Enter the bridge address below and connect."
4. localStorage URL memory verified working: last-used URL wins, then the
   transport's own URL, then the default; saved on every connect; the Copy
   button copies the current field with a clipboard fallback.

Other controls fixes: route Pause/Stop buttons now carry `title`
("Start a route first" / "No route running") when disabled; the disabled
SMS inputs got the same `title` as the SMS button ("The sim cannot inject
SMS frames"); `controls.css` lost the dead room/QR rules (markup was
removed in the bridge rewrite, including the `background: white` QR box);
`label.field`, `.cd-sec-head .n`, `.cd-linkstate`, and `.cd-num .unit`
moved from text-faint to text-dim (checklist section 9: units are
text-dim); sliders keep 32 px base and go to 40 px under 768 px.

## Shell (`src/styles/app.css`)

- `label.field` brightened to `--text-dim` (functional form labels).
- Placeholder text now explicitly `--text-dim` at full opacity.
- `.link-pill` radius changed from pill (999 px) to `var(--radius)` per the
  shape lock.
- Topbar and statusbar are `white-space: nowrap`; under 480 px the topbar
  tag and the trailing statusbar span ("internal tool, not indexed") hide
  so both bars stay on one line.

## Notes for the integrator (not fixed, out of scope)

- `main.js` calls `createTransport()` with no URL. The transport throws
  unless the page is served from port 8765 (its `defaultUrl()`), so on a
  normal vite dev port the deck shows the honest "Transport not loaded
  yet" banner and Connect stays disabled with a reason tooltip. If the
  intent is that operators can type any bridge URL and connect during dev,
  W4/main.js needs a lazy transport construction path; the deck markup is
  ready for it.
- `readTokens()` no longer has literal fallbacks. If tokens.css ever fails
  to load, the cluster degrades to canvas defaults instead of a second
  palette. This is the documented trade for the hex gate.
