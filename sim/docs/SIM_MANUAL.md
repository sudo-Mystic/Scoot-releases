# Scoot Scooter Simulator: Operator Manual

> Build status (2026-09-30): the sim webapp panels (engine, virtual
> cluster, control deck, telemetry lab, scenarios, record/replay) are
> built. The BLE bridge (`sim/bridge/jupiter-ble-bridge.py`) has not
> landed yet. Anything that depends on it is marked TODO with the owning
> worker. Everything else is grounded in `docs/PROTOCOL.md` and the built
> UI source. Do not guess beyond the TODO marks.

## 1. What this is

1. A hidden webapp that pretends to be a TVS Jupiter scooter's instrument
   cluster.
2. It exists so the Scoot Flutter app can be tested without a real scooter:
   pairing flow, telemetry display, navigation HUD, call and music
   handling.
3. It speaks the same 20-byte frame protocol the real cluster uses. The
   frame-level source of truth is `docs/PROTOCOL.md`.
4. The app runs stock. There is no Simulator mode, no special build, and
   no app-side change of any kind. The app connects to the sim over BLE
   exactly the way it connects to the real Jupiter.
5. It is an internal dev instrument. It is not user-facing.

## 2. What this is not

1. It is not connected to any real scooter, and it never will be.
2. It cannot lock, unlock, immobilize, or otherwise control a real vehicle.
   See `SAFETY.md`.
3. It is not a substitute for on-bike testing. Anything marked UNVERIFIED
   in `PROTOCOL.md` still needs a real hardware capture before anyone
   relies on it.
4. It does not work with the stock TVS Connect app. Only the Scoot app.

## 3. Prerequisites

1. A Linux laptop with Bluetooth (built-in or a USB adapter) running
   BlueZ. Install it with: `sudo apt install bluez`
   (TODO W4-bridge: confirm the minimum BlueZ version).
2. Python 3 on the laptop. Check with: `python3 --version`
   (TODO W4-bridge: confirm the minimum Python version).
3. The bridge's Python dependencies, installed with:
   `pip install -r sim/bridge/requirements.txt`
   (TODO W4-bridge: `requirements.txt` has not landed yet. The pip line
   above is the intended command; confirm the exact package list in
   `sim/bridge/README.md` once it lands.)
4. The stock Scoot Flutter app installed on the phone. No special build,
   no hidden settings.
5. Phone Bluetooth switched on, and the phone near the laptop (BLE range).
6. The phone and the laptop on the same WiFi network (the webapp needs to
   reach the bridge over the LAN).
7. This repo checked out at `~/workspace/scoot-releases/sim/`.

> Windows instead of Linux: a Windows 10+ PC with Bluetooth works too.
> The Linux bridge (`jupiter-ble-bridge.py`) cannot run on Windows at all
> (`dbus-next` is Linux-only D-Bus; do not try to install it on Windows).
> Use `sim/bridge/jupiter-ble-bridge-windows.py` instead, with
> `pip install -r sim/bridge/requirements-windows.txt`. The WebSocket
> protocol is identical, so the webapp cannot tell the two bridges apart.
> The PC's Bluetooth radio must support BLE peripheral mode; the bridge
> logs an explicit error at startup if it does not.

## 4. How the pieces fit

```
Phone: Scoot app (stock, unmodified)
        |  BLE (GATT)
        v
Laptop: jupiter-ble-bridge.py (BlueZ GATT server)
        |  advertises the real Jupiter service UUID
        |  5456534D-5647-5341-5342-454E544F5251
        |  with the real write/notify characteristics
        |  WebSocket :8765
        v
Hidden sim webapp (engine + virtual cluster + control deck
                   + telemetry lab + scenarios)
```

1. The bridge is a BlueZ GATT server on the laptop. It advertises the
   real Jupiter service UUID
   (`5456534D-5647-5341-5342-454E544F5251`) with the real write
   characteristic (`00005352-0000-1000-8000-00805f9b34fb`) and notify
   characteristic (`00005354-0000-1000-8000-00805f9b34fb`), per
   `docs/PROTOCOL.md`. The phone sees it like a real scooter's cluster.
2. The app scans, connects, and exchanges 20-byte frames through the
   GATT write/notify characteristics, exactly as it does with the real
   Jupiter. The app cannot tell the simulator from the real scooter.
3. The bridge also runs a WebSocket server on port 8765. It forwards
   bytes between the BLE side and the sim webapp in both directions.
4. The bridge does not decode frames. It moves bytes between BLE and the
   WebSocket.

> TODO (W4-bridge): confirm whether the bridge also answers GATT reads,
> and how it names the GATT application. See `sim/bridge/README.md` once
> it lands.

## 5. Setup, step by step

### Step 1: install the bridge dependencies

Linux:

1. `cd ~/workspace/scoot-releases/sim`
2. `pip install -r bridge/requirements.txt`

Windows (PowerShell):

1. `cd <repo>\sim\bridge`
2. `pip install -r requirements-windows.txt`
3. Run the Windows bridge: `python .\jupiter-ble-bridge-windows.py`

> TODO (W4-bridge): `requirements.txt` has not landed yet. Confirm the
> package list and the Python version in `sim/bridge/README.md`.

### Step 2: start the bridge

1. `cd ~/workspace/scoot-releases/sim`
2. `python3 bridge/jupiter-ble-bridge.py` (Linux) or
   `python bridge\jupiter-ble-bridge-windows.py` (Windows, from `sim\bridge`)
3. Wait for its log line saying it is advertising the Jupiter service
   UUID and listening on port 8765.
   (TODO W4-bridge: the exact log lines are not confirmed yet.)
4. Find this laptop's LAN IP: `hostname -I`. The bridge URL for the
   webapp is `ws://<LAN-IP>:8765`.

### Step 3: open the sim page

Option A, hosted (unlisted):
`https://sudo-mystic.github.io/Scoot-releases/sim/`

Option B, local (use this if you hit the mixed-content problem in
section 9):
1. `cd ~/workspace/scoot-releases/sim`
2. `npm install` (first time only)
3. `npm run dev`
4. Open the localhost URL Vite prints (usually `http://localhost:5173`).

In the sim page, enter the bridge URL (`ws://<LAN-IP>:8765`) in the link
panel and connect.

> TODO (W8): confirm the exact field and button labels in the built link
> panel. The pairing string / QR shown in the control deck was built for
> the old relay pairing; confirm what it shows against the bridge.

### Step 4: connect the phone, exactly like the real Jupiter

1. On the phone, make sure Bluetooth is on.
2. Open the Scoot app and run its normal scan and connect flow, the same
   way you would with the real Jupiter. The bridge advertises the real
   Jupiter service UUID, so the app lists it like the real cluster.
3. Connect. The sim page should show the phone as connected.

> TODO (W4-bridge): confirm the advertised device name the app shows in
> the scan list.

### Step 5: verify the link

1. In the sim, flip the Key switch to On.
2. The app should start receiving telemetry (0x10 frames) and reach
   ride-level ready.
3. Trigger something the cluster displays from the app side, for example
   start navigation, and watch the virtual cluster render the 0x4E/0x4F
   frames.
4. Open the telemetry lab panel in the sim to watch raw frames flowing in
   both directions.

## 6. Sim page panels

1. Engine: the physics core that produces speed, RPM, fuel, and battery
   values. (Built, W3.)
2. Virtual cluster: renders what a real cluster would show from app-sent
   frames (clock, signal, battery, text rows 0x4C/0x63, caller info 0x43,
   navigation 0x4E/0x4F, rider name 0x52, pictogram 0x50, music metadata
   0x61/0x62/0x65). It displays only. It never acts. (Built, W7.)
3. Control deck: scooter-side controls. See section 7. (Built, W8.)
4. Telemetry lab: raw frame inspector for both directions, with per-ID
   decode per `PROTOCOL.md`. (Built, W9.)
5. Scenarios: scripted rides. See section 8. (Built, W10.)
6. Link panel: bridge URL field, connect button, link state. (Built, W8.
   TODO: confirm labels against the bridge.)

## 7. Control deck reference

Verified against the built deck (`src/ui/controls.js`). Scooter-side
controls; each one changes the frames the app receives:

1. Key switch (Off / On). This is the simulated physical key. Only the sim
   operator moves it. No app command can move it. Off: 0x10 byte 12 = 64
   (vehicle off, only keepalive answered). On: byte 12 = 128 (ignition
   on, full telemetry flows).
2. Throttle (0-100%). Sets 0x10 byte 10.
3. Speed (km/h). Sets 0x10 byte 2. The byte-to-km/h mapping is
   provisional; see `PROTOCOL.md`.
4. Engine RPM. Sets 0x10 bytes 17-18 (big-endian UInt16).
5. Odometer (km). Sets 0x10 bytes 3-5 (UInt24, km = raw / 10). Trip meter
   sets bytes 14-16. Trip A/B reset resets the sim's own trip counters,
   which the app already reads through 0x10.
6. Fuel level. Sets 0x10 byte 6. On the 110 the raw byte passes through;
   on the 125 the low nibble is used.
7. Ride mode (ECO / POWER). Sets 0x10 byte 8 (0 = Economy, 1 = Power).
8. Battery voltage (V). Sets 0x18 byte 11 (raw = volts x 10, so 121 means
   12.10 V).
9. Engine temperature and intake air temperature. Sets 0x18 bytes 8 and 7.
10. Average and instantaneous fuel economy (km/L). Sets 0x19 bytes 8 and
    9. DTE in km sets bytes 11-12.
11. Service reminder (on / off). Sets 0x11 byte 4; nonzero means due.
12. MIL check-engine lamp (on / off). Sets 0x11 byte 10, bit 2.
13. Turn indicators (off / left / right / both). Sets 0x11 byte 12.
14. Call switch: simulate accept (1), reject (2), reject with SMS (3), or
    voice assist (4) via 0x10 byte 12. The deck also has an End call
    button.
15. Music buttons via 0x6B byte 2: Play (0), Pause (1), Next (3), Prev
    (4), Vol up (5), Vol down (6). The built deck has no toggle button.
16. DTC fault dropdown (common OBD-II style codes such as P0131, P0171,
    P0300): injects a fault code on the sim-to-app channel.
    (TODO: confirm the exact frame ID and bytes with `PROTOCOL.md` or
    W9.)
17. Route controls: pause and stop the active route.
    (TODO W8: confirm exactly what these send.)

Tyre pressure is shown in the deck as a simulated sensor readout only; it
is labeled simulated and no outbound frames are invented for it.

The deck never has lock, unlock, immobilizer, ignition-cut, throttle, or
brake controls. Those do not exist in the simulator. See `SAFETY.md`.

## 8. Scenarios and record/replay

Verified against the built UI (`src/ui/scenarios.js`,
`src/scenarios/scenarios.js`, `src/scenarios/recorder.js`).

Scenarios are scripted sequences with Run / Stop and a progress bar, for
example cold start, city ride, fault injection, and low-fuel runs. The
built scenario ids are: `city-commute`, `highway-run`,
`fault-injection`, `call-during-nav`, `low-fuel-warning`.

> TODO (W10): confirm the friendly names shown in the panel and the exact
> step content of each scenario.

Record/replay:

1. Record captures both directions of frame traffic as JSONL. Each line
   is `{"t": <ms since start>, "dir": "in"|"out", "hex": "..."}`, where
   `in` means app-sent and `out` means sim-sent. The browser downloads
   the recording as a JSONL file; there is no server-side storage.
2. Replay: pick a recording file in the panel. Only the `in` frames (the
   ones the app sent earlier) are fed back through the engine at their
   original timing. The `out` frames are kept in the file as a reference
   of what the sim emitted, but are not replayed.

> TODO (W10): confirm the download filename convention and whether
> replay is meant to run engine-only or with the phone connected.

## 9. Troubleshooting

### bluetoothd or advertising failures

1. Is bluetoothd running? Check with: `systemctl status bluetooth`
2. Is the adapter up and powered? In `bluetoothctl`, run `power on`. On
   the command line: `sudo hciconfig hci0 up`
3. Is something else holding the adapter? Only one advertiser can own it.
   Stop other BLE tools on the laptop (bleak scripts, nRF Connect, other
   GATT servers) before starting the bridge.
4. Does the kernel see the adapter? For a USB dongle: `lsusb`. For any
   adapter: `bluetoothctl list`
5. Check the bridge log for its advertising line. If the GATT app
   registration fails, the log shows it. (TODO W4-bridge: exact log and
   error text.)

### The phone does not see the bridge, or the bridge does not see the phone

1. Phone Bluetooth on, phone within a few meters of the laptop.
2. In the app's scan list, look for the advertised device name.
   (TODO W4-bridge: the advertised device name is not confirmed yet.)
3. If the phone pairs but the app never reaches the service, check the
   bridge log that the GATT app registered the service UUID
   `5456534D-5647-5341-5342-454E544F5251`.
4. Forget any old Jupiter entry on the phone from previous sessions, then
   rescan.

### The webapp will not reach the bridge

1. Is the bridge running? `python3 bridge/jupiter-ble-bridge.py` must be
   up and its WebSocket listening on 8765. Check with:
   `ss -tlnp | grep 8765`
2. Same WiFi? The webapp machine and the laptop must reach each other.
   Some guest networks isolate clients from each other.
3. Correct bridge URL? Use the laptop's LAN IP: `ws://<LAN-IP>:8765`.
   `localhost` only works when the webapp runs on the laptop itself.
4. Port conflict? If 8765 is already in use, the bridge fails to bind.
   Find the holder with `lsof -i :8765` or `ss -tlnp | grep 8765` and stop
   it. (TODO W4-bridge: confirm whether the port is configurable.)

### The sim page is https and the bridge is ws:// (mixed content)

Browsers block a secure (https) page from opening an insecure (ws://)
WebSocket. The hosted sim page is https; the bridge on your LAN is plain
ws://. Symptom: the sim page loads but never connects, and the browser
console shows a mixed-content error.

Fix: run the sim page locally over plain http:
`cd ~/workspace/scoot-releases/sim && npm run dev`, open the printed
localhost URL, then use `ws://<LAN-IP>:8765` as the bridge URL. An http
page opening a ws:// socket is allowed.

> TODO (W4-bridge): confirm whether the bridge supports TLS (wss://)
> directly.

### Phone connects but no telemetry

1. Flip the Key switch to On in the control deck. Key off means only the
   keepalive is answered; the app's ride-level UI needs the 0x10/0x11/
   0x18/0x19 frames.
2. Check framing in the telemetry lab. Every frame must be exactly 20
   bytes and end with `0xFF`. Sim-to-app frames start with `0x5A` per
   `PROTOCOL.md`.
3. The app's stale-link watchdog flags the link degraded after 10 s with
   no frames. Make sure the sim engine is running and emitting at its
   normal cadence (about every 20 ms per `PROTOCOL.md`).

## 10. FAQ

1. Does the simulator talk to a real scooter? No. It talks only to the
   stock Scoot app: phone over BLE to the laptop bridge, bridge over
   WebSocket to the sim webapp. See `SAFETY.md`.
2. Can I use it with the stock TVS Connect app? No. Only the Scoot app.
3. Does the app need a special build or a Simulator mode? No. The app
   runs stock and unmodified. There is no Simulator mode anywhere in
   this setup.
4. Can the app lock, unlock, or immobilize anything through the sim? No.
   Those code paths do not exist in the simulator or the bridge, and no
   0x9A/0xF2/0xF1 auth responses are ever constructed.
5. Which frames does the sim send? 0x10, 0x11, 0x18, 0x19 telemetry, plus
   0x6B music-button events. See `PROTOCOL.md` for the byte layouts.
6. Which app frames does the virtual cluster render? 0x4A keepalive
   (clock, signal, battery), 0x4C/0x63 text rows, 0x43 caller info,
   0x4E/0x4F navigation, 0x52 rider name, 0x50 pictogram, 0x61/0x62/0x65
   music metadata.
7. What does the bridge emulate on the BLE side? The real Jupiter GATT
   surface: service UUID `5456534D-5647-5341-5342-454E544F5251`, write
   characteristic `00005352-0000-1000-8000-00805f9b34fb`, notify
   characteristic `00005354-0000-1000-8000-00805f9b34fb` (per
   `PROTOCOL.md`). The bridge only answers GATT reads/writes/notifies
   like the real module; it invents no new characteristics.
8. Does it work over the internet, or only LAN? LAN only by design. Do
   not expose the bridge's port 8765 to the internet. BLE range limits
   the phone side anyway.
9. Is the sim page public? The URL is unlisted: the page carries
   `<meta name="robots" content="noindex, nofollow">`, `sim/` is excluded
   from `sitemap.xml`, and nothing public links to it. `robots.txt` is
   deliberately left untouched. But it is not access-controlled. Anyone
   with the link can open it. Do not share it publicly. See `SAFETY.md`.
10. Where are recordings saved? The browser downloads the JSONL recording
    file; there is no server-side storage.
    (TODO W10: confirm the download filename convention.)
11. The sim does not handle a frame I need. Check `PROTOCOL.md` section 10
    (UNVERIFIED items) and the app's protocol layer first, then file it
    against the sim with a capture.

## 11. Frame quick reference (sim to app)

| ID   | Name               | Carries                                              |
|------|--------------------|------------------------------------------------------|
| 0x10 | Primary telemetry  | speed, odometer, fuel, RPM, trip, ignition/call      |
| 0x11 | Service/diag       | service due, MIL, indicators, cluster theme          |
| 0x18 | Engine telemetry   | temps, pressures, battery volts, engine load         |
| 0x19 | Economy            | avg/instant fuel economy, DTE, ISS stats             |
| 0x6B | Music button       | play, pause, next, prev, vol up/down                 |

Full byte layouts: `docs/PROTOCOL.md`.

## 12. File map

1. `sim/`: webapp source (Vite). `npm run dev`, `npm run build`,
   `npm run preview`.
2. `sim/bridge/jupiter-ble-bridge.py`: BLE bridge. (TODO W4-bridge: not
   landed yet.)
3. `sim/bridge/requirements.txt`: bridge Python dependencies. (TODO
   W4-bridge: not landed yet.)
4. `sim/docs/PROTOCOL.md`: frame-level protocol spec, the source of
   truth.
5. `sim/docs/SIM_MANUAL.md`: this file.
6. `sim/docs/SAFETY.md`: safety boundaries. Read it before operating the
   sim.
