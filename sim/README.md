# Scoot Scooter Simulator (internal dev bench)

Hidden simulator webapp for testing the Scoot Flutter app against a
virtual TVS Jupiter scooter BLE side. Served from the
`Scoot-releases` repo at `/Scoot-releases/sim/` on GitHub Pages.
**Internal tool. Not indexed, not linked from anywhere public.**

## Run

```sh
cd sim
npm install
npm run dev        # local dev server (serves the app.html source shell)
npm run build      # production build into dist/
npm run deploy     # build + publish dist into ./index.html + ./assets/ (commit those)
npm run preview    # serve the production build
```

## Deploy

Pages serves the repo root, and `/Scoot-releases/sim/` must serve a
WORKING page. The Vite source entry is `app.html` (deliberately NOT
`index.html`): `npm run deploy` runs `vite build`, copies
`dist/app.html` to `./index.html`, and copies `dist/assets/` alongside
it, then you commit the resulting `sim/index.html` + `sim/assets/`.
`dist/` itself stays gitignored. Never hand-edit the shipped
`sim/index.html`; edit `app.html` / `src/` and re-run `npm run deploy`.

The Vite `base: './'` config keeps all asset paths relative so the
build works under `/Scoot-releases/sim/`.

## Structure

```
sim/
  app.html              page shell SOURCE (noindex); dev serves this file
  index.html            BUILT bundle, shipped on Pages (regenerate via npm run deploy)
  vite.config.js        base './', outDir dist
  package.json          vite + vanilla JS only
  CONTRACT.md           module contract (read before touching anything)
  README.md             this file
  docs/PROTOCOL.md      BLE frame byte maps (W1)
  src/
    main.js             W6: wires engine -> transport, 50ms tick, mounts panels
    bus.js              W6: tiny cross-panel event emitter
    engine/             W3: simulation logic (createEngine)
    transport.js        W4: WebSocket bridge link (createTransport)
    ui/
      cluster.js        W7: cluster display
      controls.js       W8: control deck
      lab.js            W9: telemetry lab
      scenarios.js      W10: scenarios
    styles/
      tokens.css        W6: design tokens, volt-lime accent lock
      app.css           W6: shell layout + shared primitives
```

## Docs

- [docs/SIM_MANUAL.md](docs/SIM_MANUAL.md) - operator manual: how to run
  the sim, pair the phone, and drive a test session.
- [docs/SAFETY.md](docs/SAFETY.md) - safety boundary: what the sim must
  never do (telemetry/display/mirroring only).
- [docs/PROTOCOL.md](docs/PROTOCOL.md) - BLE frame byte maps (W1).
- [docs/tvs-addendum.md](docs/tvs-addendum.md) - second-source delta from
  TVS xConnect dex research (W2); cross-referenced from PROTOCOL.md.
- [CONTRACT.md](CONTRACT.md) - module contract (read before touching anything).

## Ownership

- W3 engine, W4 transport, W7 cluster, W8 controls, W9 lab,
  W10 scenarios, W11 profiles, W6 shell (this scaffold).
- The shell imports every other worker's module defensively; the app
  boots and builds even when panels have not landed.
- Do not commit (integrator W15 commits).

## Hidden wiring (keep hidden)

- `<meta name="robots" content="noindex, nofollow">` in app.html (survives
  the build into the shipped index.html).
- `sitemap.xml` MUST NOT list `sim/` (verified 2026-09-30).
- Nothing links to `sim/` from index.html, privacy.html, terms.html.
- robots.txt is left untouched; hiding relies on meta + no sitemap +
  no links.

## Fonts

System mono stack only (`--font-mono`). If a self-hosted font is ever
wanted, use fontsource with @font-face; never a Google Fonts `<link>`
in production (sandbox cannot reach fonts.googleapis.com anyway).
