#!/usr/bin/env bash
# Deploy the sim webapp to sim/ for GitHub Pages.
#
# Why this exists: the boot bundle (assets/index-*.js) loads six modules via
# @vite-ignore dynamic import() — ./ui/*.js, ./engine/index.js, ./transport.js.
# Vite intentionally leaves those specifiers untouched, so they must be
# deployed as plain static files next to the bundle. `vite build` alone does
# NOT emit them, and a deploy that only copies dist/ leaves every panel
# stuck on "pending" (six 404s, console errors). This script copies the
# runtime module tree explicitly.
#
# Layout note: dynamic import() resolves relative to the importing module,
# i.e. sim/assets/index-*.js, so the canonical home is sim/assets/<tree>.
# A second copy is mirrored at sim/<tree> because some clients were observed
# resolving against the page root. Both are static and harmless.
#
# One source transform: src/ui/controls.js has `import '../styles/controls.css'`
# which is legal for Vite but throws in a raw browser ES module (CSS is not a
# JS module). The deployed copies strip that line; index.html links the
# stylesheet directly instead.
set -euo pipefail
cd "$(dirname "$0")/.."

./node_modules/.bin/vite build

# 1. Ship the Vite bundle.
rm -rf assets index.html
cp dist/app.html index.html
cp -r dist/assets assets

# 2. Ship the runtime modules Vite leaves alone (canonical: bundle-relative).
mkdir -p assets/ui assets/engine assets/scenarios assets/styles
cp src/ui/cluster.js src/ui/lab.js src/ui/scenarios.js assets/ui/
grep -vF "import '../styles/controls.css';" src/ui/controls.js > assets/ui/controls.js
cp src/engine/index.js src/engine/engine.js src/engine/frames.js \
   src/engine/physics.js src/engine/profiles.js assets/engine/
cp src/scenarios/scenarios.js src/scenarios/recorder.js assets/scenarios/
cp src/transport.js assets/transport.js
cp src/styles/controls.css assets/styles/controls.css

# 3. Mirror at sim/ root (page-relative resolution fallback).
mkdir -p ui engine scenarios styles
cp assets/ui/* ui/
cp assets/engine/* engine/
cp assets/scenarios/* scenarios/
cp assets/transport.js ./transport.js
cp assets/styles/controls.css styles/controls.css

# 4. Link the controls stylesheet (replaces the stripped CSS import).
if ! grep -q 'assets/styles/controls.css' index.html; then
  sed -i 's|\(<link rel="stylesheet" crossorigin href="./assets/index-[^"]*\.css">\)|\1\n    <link rel="stylesheet" href="./assets/styles/controls.css">|' index.html
fi

echo "deploy complete: bundle + runtime modules + controls.css linked"
