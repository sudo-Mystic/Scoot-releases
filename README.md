# Scoot — download the app

**Scoot** is a companion app for TVS scooters. It talks to your scooter over
Bluetooth: live telemetry on your phone, turn-by-turn navigation and call/SMS
alerts on the scooter's cluster display, automatic trip recording, and a memory
of where you parked.

**Supported:** TVS Jupiter 110/125 · TVS Ntorq 125 (partial)

## Get the app

The easiest way is the download site, which always points at the latest
release with install instructions:

**https://sudo-mystic.github.io/Scoot-releases/**

Or grab the APK directly: [stable/arm64 APK](stable/0.4.8/app-arm64-v8a-release.apk)
(fits almost every modern Android phone).

## Install

1. Download the APK on your phone.
2. Open it. Android will ask you to allow installs from your browser/file
   manager — allow it once.
3. Tap **Install**.
4. Updates appear inside the app under Settings → App, or come back here.

## Check your download (optional)

Every APK ships with a SHA-256 checksum in its
[manifest](stable/0.4.8/manifest.json). The download site can verify the file
for you: pick the APK you downloaded and it checks the hash in your browser.
Nothing is uploaded.

## What's new

See the [download site](https://sudo-mystic.github.io/Scoot-releases/) for
the latest release notes. Older versions live under
[`stable/`](stable/), each with its own manifest and notes.

---

## For developers

This repo is Scoot's public OTA feed. The app polls
[`stable/manifest.json`](stable/manifest.json) for updates and verifies the
APK's SHA-256 before installing. The app's source code lives in the private
`sudo-Mystic/Scoot` repo and is never published here.

Layout:

- `stable/manifest.json` — latest stable manifest (what the app polls).
- `stable/<version>/` — APKs + manifest per stable version.
- `stable/versions.json` — newest-first version list (powers the site's archive).
- `beta/` — same layout, when beta builds ship.

Releases are published automatically by the `android-release` workflow in the
source repo.
