# Scoot-releases

Public OTA artifact feed for the **Scoot** scooter companion app.

This repo contains **only built release artifacts** (APKs) and update
manifests. The app's source code lives in the private
`sudo-Mystic/Scoot` repo and is never published here.

## Layout

- `stable/manifest.json` — latest stable update manifest; the app polls this.
- `stable/<version>/` — archived artifacts per stable version.
- `beta/manifest.json` — latest beta manifest (when beta builds ship).

## Manifest format

See `stable/manifest.json` once the first release is published. Each
manifest carries the version, versionCode, release notes, and per-ABI
APK download URLs with SHA-256 checksums, which the in-app updater
verifies before installing.

Published automatically by the `android-release` workflow in the
private source repo.
