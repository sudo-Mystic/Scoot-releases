# Verification Report: Scoot Scooter Simulator frame layer (W12)

Date: 2026-09-30. Verifier: worker W12 (independent verification).
Authority for all expected values: the Scoot Flutter app sources
(`~/workspace/projects/scoot/lib/vehicles/tvs_jupiter/`, dex-verified
against TVS Connect v8.12.4), NOT the sim's own code. Golden frames were
hand-constructed byte by byte from the documented layout, and expected
values were computed by hand, so the tests genuinely cross-check the
layout instead of echoing an implementation.

## 1. What was tested

### 1.1 Golden-vector suite: `sim/tests/golden.test.js`

Zero-dependency `node:test` suite. Run: `cd ~/workspace/scoot-releases/sim && node --test tests/golden.test.js`.

- Part A: faithful JS mirrors of the Dart decoders
  (`jupiter_telemetry.dart` decodePrimary/decodeService/decodeEngine/
  decodeEconomy/decodeMusicCommand/mediaKeyKindFor, `jupiter_checksum.dart`
  jupiterChecksum/jupiterChecksumMatches/jupiterVerifyFrame,
  `jupiter_constants.dart` frame constants, the 0x6B dispatch in
  `jupiter_ble_session.dart`). These exist so the golden vectors are
  executable now; they mirror the Dart line for line.
- Part B: golden vectors, hand-built inbound frames with hand-computed
  expectations:
  - 0x10: speed 42 kph (byte 2); odo bytes 00 30 39 -> raw24 12345 ->
    1234.5 km; fuel byte 0x35 with the 110 passthrough vs 125 low-nibble
    rule (110: fuelLevel 53, reserve true; 125: fuelLevel 5, reserve
    false; fixtures 0x3C -> 12, 0x80 -> 0); ignition byte 12 = 128
    (IG on, vehicleOff false); avg 38, eco/power 1 (power), top 89,
    throttle 64, backlight 0x01, t60 raw 0, trip 00 03 E8 -> 100.0 km,
    RPM bytes 0E 10 -> 3600. Wrong ID / wrong length rejected.
  - 0x18: battery raw 126 -> 12.6 V; engine temp 87 C; engine load 45;
    fuel-inj time BE 300; MAP 78; baro U714 101; intake 35; baro BE 1000;
    run time BE 60; distance BE 100; fuel-inj volume BE 600. Rounding
    parity: raw 121 -> 12.10. Wrong ID rejected.
  - 0x19: instant FE 45 km/L (byte 9); avg FE 52 (byte 8); DTE BE 180 km
    (bytes 11-12); ISS duration raw24 30; OTA 1; ISS count raw24 7.
  - 0x11 DTC set: serviceReminder true, MIL blink 3, diagnostics 0x04 ->
    milOn true, model byte 9 = 2 surfaced raw, ISS byte 0x11, sw ver 5,
    vehicle state 2, ISG blink 1, theme 2. DTC absent: milOn false,
    blink 0, reminder false.
  - 0x6B: full dex-verified command map 0..6 (play/pause/toggle/next/
    previous/volumeUp/volumeDown); command 3 -> next -> media key next;
    command 7 -> null (no dispatch); legacy raw accessor returns index.
  - Checksum: formula fixtures (all-zero -> 255; [0x5B,0x10,...] -> 148;
    all-0xFF -> 17); positive case matches, single-bit flip detected;
    inbound decode explicitly NOT gated on checksum (the golden 0x10
    carries the RPM low byte at byte 18, checksumMatches is false, and
    decode + structural verify still pass, matching the Dart comment
    about the on-hardware "cksum BAD, frozen speed" incident).
  - Frame anatomy: all golden frames 20 bytes, start 0x5A, end 0xFF;
    inbound start-byte superset 0x5A / 0x9B / 0x5B accepted; bad start,
    bad end, short (19) and long (21) frames rejected.
- Part C: engine cross-check. The engine (`sim/src/engine/frames.js`)
  builds inbound frames and decodes outbound ones, so verification runs
  both directions: engine builder output -> Dart-mirror decode -> golden
  expectations, byte-exact against the Part B vectors (e.g. every byte of
  `buildPrimary({...})` matches the golden 0x10 frame), plus
  `jupiterChecksum` formula fixtures.
- Part D: reconciliation pin (W9 vs W3, 2026-09-30). Mirrors the Dart
  outbound builders `buildNavControlFrame` (jupiter_navigation.dart:217)
  and `buildVehicleControlFrame` (jupiter_settings.dart:39) and pins that
  both lead with 0x5A at index 0; asserts the engine's `decodeOutbound`
  accepts both. The nav-control acceptance test currently fails against
  W3's code (verdict: W9 right, section 4 of VERIFICATION.md).

### 1.2 Other suites

- `sim/src/engine/engine.test.js` (W3): NOT PRESENT at verification time.
- Profiles tests (W11): NOT PRESENT at verification time.
- `sim/src/engine/profiles.js` (landed during this session): smoke-checked
  only (syntax OK, imports cleanly, exposes jupiter110/jupiter125/ntorq
  with encodeFuelByte/decodeFuelByte, lowercase UUIDs, 20 ms cadences).
  Not modified.

## 2. Results

| Suite | Pass | Fail | Skipped | Notes |
|---|---|---|---|---|
| tests/golden.test.js (Parts A/B: inbound golden vectors) | 21 | 0 | 0 | 102 executed assertions |
| tests/golden.test.js (Part C: engine cross-check) | 9 | 0 | 0 | engine builders -> app-decode round trip, byte-exact vs golden vectors |
| tests/golden.test.js (Part D: 0x5A-lead reconciliation pin) | 4 | 1 | 0 | 1 known failure: 'decodeOutbound accepts 0x5A-lead nav-control', pending W3's fix (section 4) |
| src/engine/engine.test.js (W3) | 15 | 0 | 0 | - |
| src/engine/profiles.test.js (W11) | 17 | 0 | 0 | - |
| Combined (`node --test tests/golden.test.js src/engine/profiles.test.js src/engine/engine.test.js`) | 66 | 1 | 0 | the single failure is the pinned W3 bug |

Target was at least 15 assertions; well over 150 executed across the
suite. Run: `cd ~/workspace/scoot-releases/sim && node --test tests/golden.test.js`.

## 3. Discrepancies found (NOT fixed; routed for owner decision)

### 3.1 PROTOCOL.md section 9 misstates the Ntorq battery source

- File: `sim/docs/PROTOCOL.md`, section 9 (Ntorq deltas), bullet: "Ntorq
  battery voltage comes from the 0x11 byte 6 x0.1 path (Ntorq-only);
  Jupiter uses 0x18 byte 11."
- Dart source: `lib/vehicles/tvs_ntorq/ntorq_telemetry.dart`,
  `decodeNtorqEngine` (line ~343): `batteryVoltageRaw: frame[11]` with
  `batteryVoltage => batteryVoltageRaw * 0.1`, and the class doc "Byte 11
  raw. CONFIRMED scaling: raw * 0.1 = volts." This is the 0x18 engine
  frame, identical to Jupiter. No 0x11 byte-6 battery path exists in the
  decoder.
- Note: `sim/src/engine/profiles.js` (ntorq notes) already caught this and
  sides with the Dart source. The doc is what needs the fix.
- Reproduction: open PROTOCOL.md section 9, compare with
  ntorq_telemetry.dart lines ~310-345.

### 3.2 profiles.js 110 fuel decode diverges from the Dart 110 branch

- File: `sim/src/engine/profiles.js`, `jupiter110.decodeFuelByte`:
  `(byte & 0x0f) / FUEL_STEPS` (low nibble only, normalized 0..1).
- Dart source: `jupiter_telemetry.dart`, `decodePrimary` 110 branch:
  `fuelLevel = fuelRaw` (full byte passthrough), `fuelBars = fuelLevel`
  (full byte), `reserve = (fuelRaw & 0xF0) != 0`.
- Concrete divergence: `encodeFuelByte(0.10)` emits wire byte 0x82 (2 bars
  in the low nibble, 0x80 reserve flag). The real app decodes this as
  fuelLevel 130, fuelBars 130, reserve true. The sim's own
  `decodeFuelByte(0x82)` returns 0.133 (2/15). The sim cluster UI and the
  app would show different fuel readings for the same frame.
- The profile documents this as a deliberate sim convention ("Scoot's
  provisional bars interpretation reads the low nibble as the bar count"),
  but that comment misattributes: the Dart sets `fuelBars = fuelLevel =
  full raw byte`. Either the comment or the decode needs correcting, or
  the divergence needs an explicit "intentional, sim-side only" sign-off.
- Reproduction: `node -e "import('./src/engine/profiles.js').then(m =>
  console.log(m.getProfile('jupiter110').decodeFuelByte(0x82)))"` prints
  0.133..., while the Dart mirror in golden.test.js decodes 0x82 on the
  110 branch as fuelLevel 130, reserve true.

No byte-layout bugs were found in a frame engine, because the frame
engine (`src/engine/frames.js`) had not landed at verification time.

## 4. Reconciliation verdict: 0x5A lead byte on outbound frames (2026-09-30)

Dispute: W9's telemetry-lab accepts a 0x5A lead byte on outbound
nav-control frames; W3's `decodeOutbound` flags any 0x5A lead byte as
bad-start (except 0xF1).

VERDICT: W9 is right. The Dart sources are unambiguous:

- `lib/vehicles/tvs_jupiter/jupiter_navigation.dart:217-218`,
  `buildNavControlFrame`: `packet[0] = JupiterId.navControl0` (0x5A per
  `jupiter_constants.dart:63`), `packet[1] = JupiterId.navControl1`
  (0x4E). The nav-control frame goes on the wire as
  `5A 4E dist(2) eta(2) remaining(3) pictogram rowCount navStatus 00-pad FF`.
- `lib/vehicles/tvs_jupiter/jupiter_settings.dart:39-40`,
  `buildVehicleControlFrame`: `f[0] = 0x5A`, `f[1] = 0xF1` (brightness).
- Contrast: `buildNavTextFrame` (`jupiter_navigation.dart:182`) and
  `buildCalibrationFrame` (`jupiter_settings.dart:57`) both use lead
  0x5B. The 0x5A lead is specific to these two frame types.

Bug in W3's file: `sim/src/engine/frames.js`, `decodeOutbound`
(start-byte gate): the 0x5A-lead exemption covers only
`ID_VEHICLE_CONTROL` (0xF1), so a real `[0x5A, 0x4E, ...]` nav-control
frame is rejected as `{known:false, kind:'bad-start'}`. Golden test
'decodeOutbound accepts 0x5A-lead nav-control (W9 right, W3 fix pending)'
in `tests/golden.test.js` (Part D) pins the correct behavior and
currently FAILS, demonstrating the bug. The fix-boundary test pins that
0x5A lead stays bad-start for ordinary frames (e.g. 0x4A).

Fix for the integrator (W3's file, not applied by W12):
```
const start5aOk = start === 0x5a &&
  (id === ID_VEHICLE_CONTROL || id === ID_NAV_CONTROL);
if (start !== START_PHONE && !start5aOk) {
  return { known: false, kind: 'bad-start' };
}
```
No checksum change needed: the nav-control case never checks a checksum,
matching the Dart builder (bytes 12-18 stay 0x00, no addChecksum).

Related doc fix (W1): `sim/docs/PROTOCOL.md` section 4, nav-control
table, row "Byte 0: 0x5B" contradicts the Dart builder; byte 0 is 0x5A
(the section heading "0x5A 0x4E" is the correct one).

## 5. Manual end-to-end checklist (app Simulator mode -> relay -> sim webapp)

Prerequisites: Scoot app built with Simulator mode, sim webapp running
(`npm run dev` in `~/workspace/scoot-releases/sim`), relay bridging the
app's BLE to the sim.

1. Pairing: start the sim, put the app in Simulator mode, scan. Expect:
   the sim advertises with a jupiter/tvsbt/tvs name hint and the Jupiter
   service UUID; the app lists it; connect succeeds; service discovery
   finds the service UUID plus write and notify characteristics; the app
   subscribes to notify BEFORE setNotify(true).
2. Key on: in the sim UI, flip ignition ON. Expect: the app's next 0x10
   frame carries byte 12 = 128; app shows ignition-on state; parked pin
   clears if applicable.
3. Throttle up: drag the sim throttle / speed control to 42 kph. Expect:
   the app's live speed reads 42 (0x10 byte 2); odometer advances;
   technical telemetry screen shows matching RPM/trip values.
4. Nav from app: start navigation in the app to a destination. Expect:
   the sim webapp cluster HUD shows the maneuver pictogram, distance,
   and ETA from the 0x5A4E control frames; text rows (0x4C/0x63) show the
   road name; HUD keepalive (~1 s) keeps the nav screen up.
5. Inject DTC: in the sim, set 0x11 byte 10 bit 2 (or use the sim's DTC
   injector). Expect: the app's diagnostics screen shows MIL on with the
   blink code from byte 8; clearing the injection clears the MIL.
6. Record/replay: record a 60 s session (key on, throttle sweep, one DTC
   inject, one 0x6B button press) via the sim recorder; replay it.
   Expect: the app shows the identical sequence (speed curve, MIL
   on/off, media-key event) with matching timestamps; replay is
   deterministic across two runs.
7. Negative checks: stop the sim's telemetry for 12 s; expect the app's
   stale-link watchdog emits degraded at ~10 s and clears on resume.
   Send a frame with a corrupted byte 18; expect the app still decodes it
   (inbound checksum is informational only).

## 6. Open items for the parent

- Route the section 4 verdict to W3: apply the `decodeOutbound` start-byte
  fix (one-line change, exact code in section 4); the pinned golden test
  goes green once applied. Do not touch W3's file from this side.
- Route discrepancy 3.1 to the PROTOCOL.md owner (W1): fix the Ntorq
  battery bullet in section 9 and the nav-control byte-0 row in section 4.
- Route discrepancy 3.2 to the profiles owner (W11) for a
  fix-or-sign-off decision on `jupiter110.decodeFuelByte`.
- The golden suite's Part A mirrors are pinned to the Dart sources as of
  2026-09-30; any Dart decoder change must be re-mirrored and the golden
  expectations re-derived by hand.

## 7. Bridge verification (W12)

Status: script written and self-checked; live results TODO (hardware
dependent, the user runs it). The bridge script
(`sim/bridge/jupiter-ble-bridge.py`, W4) was not present at the time of
writing, so the verifier was written against the protocol spec in the
task and PROTOCOL.md, marked "pending bridge" for the live run.

### 7.1 Script: `sim/bridge/verify_bridge.py`

Stdlib + `bleak` + `websockets` (deps in `sim/bridge/requirements.txt`;
install with `pip install bleak websockets`). Prints PASS/FAIL per step
with byte-level hex detail on failure; exit code 0 only if every step
passes. Expected values are taken from PROTOCOL.md (frame anatomy,
UUIDs, checksum formula), never from the bridge implementation.

Steps, in order:

1. WS handshake: connect to `ws://127.0.0.1:8765`, send
   `{"t":"join","role":"sim"}`, require a JSON message with
   `t == "joined"` (extra fields such as room/peer tolerated).
2. BLE discovery: bleak scan for service UUID
   `5456534D-5647-5341-5342-454E544F5251` (lowercase compare per
   PROTOCOL.md); name "Jupiter-SIM" is a fallback hint only, with a
   printed warning. Connect, discover services, assert the write char
   `00005352-0000-1000-8000-00805f9b34fb` and notify char
   `00005354-0000-1000-8000-00805f9b34fb` exist. Prints every
   discovered service and characteristic with properties.
3. Bidirectional frame relay, byte-exact:
   - 3a (BLE -> WS): write a 20-byte `0x5B` frame (ID 0x4A, checksum at
     byte 18 per the section 2 formula, `0xFF` at byte 19) to the write
     characteristic via bleak; the WS client must receive the SAME bytes
     as binary within 5 s.
   - 3b (WS -> BLE): send a 20-byte `0x5A` binary frame (ID 0x10) via WS;
     the bleak notify callback must receive it byte-identical within
     5 s. Any first differing byte index is printed.
4. Malformed handling: send a 19-byte binary frame via WS; the bridge
   must drop it. Pass requires no notify fires within 3 s AND no binary
   is forwarded to WS clients. A `{"t":"error"}` text reply is logged as
   info and does not affect the verdict.

Modes: `--skip-ble` runs the WS steps only (step 1 + the WS side of step
4, no BT adapter needed). `--self-test` validates this script's own WS
client logic against an in-process mock bridge (join/joined handshake,
20-byte binary echo, 19-byte drop); no bridge and no BLE involved. This
mode passed 4/4 on 2026-09-30, and the checksum/frame builders were
checked against the section 2 fixtures (all-zero -> 255,
`[0x5B,0x10,...]` -> 148, all-0xFF -> 17). A full run with no bridge
listening fails step 1 cleanly with `ConnectionRefusedError` and exit 1.

### 7.2 Prerequisites for the live run

- The bridge running: `python3 sim/bridge/jupiter-ble-bridge.py`
  (W4-bridge; starts the WS server on port 8765 and the BlueZ GATT
  server).
- Linux host with a Bluetooth adapter and `bluetoothd` running; the
  verifying user needs permission to use the adapter (bluetooth group /
  appropriate polkit).
- Python 3.10+ with `pip install bleak websockets` (a venv is fine).
- No phone needed; bleak acts as the BLE central.

Run: `cd ~/workspace/scoot-releases/sim/bridge && python3 verify_bridge.py`

### 7.3 Results

TODO (hardware-dependent). The user runs the script against the live
bridge and records PASS/FAIL per step here. Known at script time: no
bridge bugs could be found because the bridge was not yet present; the
script reports deviations precisely (file, function, expected vs actual
bytes) instead of modifying the bridge.
