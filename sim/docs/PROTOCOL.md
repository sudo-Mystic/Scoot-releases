# TVS Jupiter BLE Protocol (v1) - Scoot Simulator Spec

Single source of truth for the Scoot Scooter Simulator (hidden webapp in
`~/workspace/scoot-releases/sim/`). Extracted 2026-09-30 from the Scoot
Flutter app's protocol layer (`~/workspace/projects/scoot/lib/vehicles/
tvs_jupiter/`, dex-verified against TVS Connect v8.12.4). Never invent
values: anything that cannot be verified from those sources is marked
UNVERIFIED.

SAFETY BOUNDARY (non-negotiable): Scoot is telemetry/display/mirroring
only. The simulator MUST NOT implement lock/unlock, immobilizer,
ignition-cut, throttle or brake control. The 0x9A/0xF2/0xF1 auth path is
detect-only: the app never builds or sends a response.

## 0. Second-source addendum (TVS xConnect dex research, 2026-09-30)

`docs/tvs-addendum.md` (worker W2, tvs-crosscheck) is the DELTA between
the Dart sources and bytecode-level research on TVS xConnect v8.12.4.
It is kept as a separate file and summarized here so nothing is lost;
when a finding amends a section below, the addendum wins on confidence.

| Finding | Amends | Delta | Confidence |
|---------|--------|-------|------------|
| F1 0x22 pad fill | 0x22 section | Real app pads with 0xFF, not 0x00 (contradicts the Dart) | CONFIRMED |
| F2 0x22 sequencing | Connection/auth sequencing | Phone writes 0x22 on connect from the account DB; sim accepts any user ID | CONFIRMED |
| F3 first-write gate | Connection/auth sequencing | Cluster frames parsed only after the phone's first write (mirrored by the sim's fidelity gate, see engine.js) | CONFIRMED (phone side); cluster mirror UNVERIFIED |
| F4 0x54 doc-transfer layout | 0x54 section | Cluster->phone: byte 2 = picNo, bytes 5-6 = BE16 frame number | CONFIRMED |
| F5 0x55 image chunks | Frame-ID table | New ID 0x55: phone->cluster, `[5A, 55] + frameNo + chunk + [00, FF]` | CONFIRMED |
| F6 0x53 init image transfer | 0x53 SMS note | 0x53 also used for init-image-transfer with header `[5A, 53]`; a different payload shape on the same ID as SMS | CONFIRMED (header); payload UNVERIFIED |
| F7 image-transfer model gating | Model gating | Jupiter 125 uses 173-byte image chunks; caller-image sync applies to Jupiter | CONFIRMED |
| F8 0x60 play/pause-state | Frame-ID table | New ID 0x60: phone->cluster `[5B, 60, 00, currentHour, 00, 00, 00, stateByte, 00 x 11, FF]` | CONFIRMED (layout); Jupiter applicability UNVERIFIED |
| F9 0x6B music map | Music map | Dex read matches the Dart exactly; no delta | CONFIRMED |
| F10 Jupiter send paths | Phone->cluster coverage | `JupiterMobileToCluster` has untraced send paths (weather, cricket, football, news, traffic, TSL, follow-me headlamp, vehicle settings): phone->cluster, so out of sim scope | CONFIRMED (existence); frames UNVERIFIED |
| F11 research gaps | UNVERIFIED list | Text paging cycle, timing/cadence, 0x52 builder, 0x61/0x62/0x65 mapping: silent in this source | - |
| F12 keyless entry | Safety boundary | AES key location noted; no key material reproduced | location only |

Three findings have already been merged into this document: nav-control
byte 0 is 0x5A (section 4), 0x22 pads with 0xFF (0x22 section), and the
Ntorq battery voltage path is 0x18 byte 11 x0.1 (Ntorq section).

## 1. Frame anatomy

Every frame is exactly 20 bytes.

```
Phone -> cluster (outbound):
+------+------+------+------+ ... +------+------+------+
| [0]  | [1]  | [2]  | [3]  | ... | [17] | [18] | [19] |
+------+------+------+------+ ... +------+------+------+
  0x5B   ID   payload (16 bytes)     cksum   0xFF

Cluster -> phone (inbound):
+------+------+------+------+ ... +------+------+------+
| [0]  | [1]  | [2]  | [3]  | ... | [17] | [18] | [19] |
+------+------+------+------+ ... +------+------+------+
  0x5A   ID   payload (16 bytes)    (info)   0xFF
```

* Byte 0 (outbound): `0x5B` (JupiterFrame.startByte).
* Byte 0 (inbound): `0x5A` is the primary cluster start byte;
  `0x9B` is accepted as an alternate inbound start byte (per the real
  app's `isValidFrame`); `0x5B` is also accepted inbound (superset seen in
  RE report captures). The simulator emits `0x5A`.
* Byte 1: data ID.
* Byte 19: `0xFF` always.
* Byte 18 (outbound): checksum, see section 2. Every outbound builder in
  the app computes it.
* Byte 18 (inbound): NOT gated. The real cluster does not reliably
  compute the phone-side formula and the real app never verifies inbound
  checksums. Inbound validation is structural only: length == 20, valid
  start byte, end byte == 0xFF. The checksum match at byte 18 is recorded
  as informational only.

UUIDs (GATT):

* Service: `5456534D-5647-5341-5342-454E544F5251`
* Write characteristic: `00005352-0000-1000-8000-00805f9b34fb`
* Notify characteristic: `00005354-0000-1000-8000-00805f9b34fb`
* Comparisons must be lowercase (the BLE stack normalizes UUIDs to
  lowercase).

## 2. Checksum

Exact formula (byte 18 of outbound frames, informational inbound):

```
checksum = 255 - (sum(bytes[0..17]) % 256)
```

Exact Dart code (`jupiter_checksum.dart`):

```dart
int jupiterChecksum(List<int> first18Bytes) {
  assert(first18Bytes.length == 18, 'checksum covers bytes 0..17');
  var sum = 0;
  for (final b in first18Bytes) {
    sum += b & 0xFF;
  }
  return 255 - (sum % 256);
}
```

The calibration frame (0x73) uses a different, dex-verified formula:

```
checksum = (256 - (sum(bytes[2..8]) % 256)) & 0xFF
```

## 3. Inbound frame IDs (cluster -> phone)

The app decodes these; the simulator emits them.

### 0x10 Primary telemetry (JupiterSpeedOMeter1, dex-verified 2026-09-25)

| Byte(s) | Field | Decode |
|---------|-------|--------|
| 0 | start | 0x5A |
| 1 | ID | 0x10 |
| 2 | speed | km/h raw byte. PROVISIONAL, needs HCI capture |
| 3-5 | odometer | UInt24 big-endian; km = raw / 10.0 UNVERIFIED |
| 6 | fuel byte | see 110 vs 125 rule below |
| 7 | average speed | km/h raw |
| 8 | ECO/POWER | 0 = Economy, 1 = Power (anything else defaults to Economy). NOTE: dex decode is dead code in stock app (no callers); high nibble == 7 means traffic screen up |
| 9 | top speed | km/h raw |
| 10 | throttle position | raw byte |
| 11 | backlight / BT pair mode | raw; low nibble street/sport on some models (9 = Race, 1 = Sport) UNVERIFIED, stock decode is dead code |
| 12 | ignition/call switch | 128 = IG on, 64 = vehicle off. Other values drive the call switch: 1 = accept, 2 = reject, 3 = reject with SMS, 4 = voice assist (dex-verified). App edge-triggers answer/reject events on 1/2 only |
| 13 | 0-60 raw | NOT a usable 0-60 time on Jupiter (dex getter only feeds ZEST branch); surfaced raw |
| 14-16 | trip meter | UInt24 big-endian; km = raw / 10.0 |
| 17-18 | engine RPM | UInt16 big-endian |
| 19 | end | 0xFF |

110 vs 125 fuel byte rule (dex-verified `handleSpeedOMeter`,
gated on JUPITER_U566): on the 125, stock applies `int2bytes`, which
extracts the LOW NIBBLE: `0x3C -> 12`, `0x35 -> 5`, `0x80 -> 0`
(equivalent to `raw & 0x0F` for a single hex digit). On the 110
(U279/U745) stock passes the raw byte through. Bars and reserve reading
are Scoot interpretation and PROVISIONAL: on the 110, reserve = upper
nibble nonzero (UNVERIFIED); on the 125 reserve is always false.

### 0x11 Service / diagnostics (JupiterSpeedOMeter2, no model gate)

| Byte(s) | Field |
|---------|-------|
| 2 | fuel sensor failure |
| 3 | vehicle state 1 |
| 4 | service reminder (nonzero = due) |
| 6 | ISS high/low + vehicle state 2 (shared byte; bit layout not decoded) |
| 7 | speedo SW version |
| 8 | MIL blink code |
| 9 | vehicle model numeric. Values NOT in the dex; surfaced raw, never used for gating |
| 10 | vehicle diagnostics; bit 2 (0x04) = MIL state |
| 11 | ISG blink code |
| 12 | turn indicator status |
| 13 | connector status |
| 14 | cluster theme (stock: currentClusterTheme) |
| 17 | capture screenshot |
| 5, 15, 16 | unused |

### 0x18 Engine telemetry (JupiterSpeedOMeter4, no model gate)

| Byte(s) | Field |
|---------|-------|
| 2 | engine load |
| 3-4 | accumulated fuel injection time, BE UInt16 |
| 5 | manifold air pressure |
| 6 | barometric pressure (U714 variant) |
| 7 | intake air temperature |
| 8 | engine temperature |
| 9-10 | barometric pressure, BE UInt16 |
| 11 | battery voltage raw; volts = raw x 0.1, rounded to 2 decimals, no offset (dex-verified `getBatteryVoltage`; raw 121 -> 12.10 V) |
| 12-13 | engine running time, BE UInt16 |
| 14-15 | distance traveled, BE UInt16 |
| 16-17 | fuel injection volume, BE UInt16 |

### 0x19 Economy (JupiterSpeedOMeter3, no model gate)

| Byte(s) | Field |
|---------|-------|
| 2-4 | ISS duration raw, 24-bit (units not decoded) |
| 5 | OTA status raw |
| 8 | average fuel economy, km/L |
| 9 | instantaneous fuel economy, km/L |
| 11-12 | DTE, BE UInt16, km (dex-verified) |
| 15-17 | ISS count raw, 24-bit |

### 0x6B Music button (cluster -> phone, dex-verified command map)

Command at byte 2 (from `BluetoothUtil.getMusicCommandType`):

| Value | Command |
|-------|---------|
| 0 | play |
| 1 | pause |
| 2 | toggle (play/pause) |
| 3 | next |
| 4 | previous |
| 5 | volume up |
| 6 | volume down |

Note: in stock, Jupiter's `parseData` only logs 0x6B; only Ntorq wires
the map. Scoot dispatches it as its own media-key feature on both models.

### 0x54 Doc / image transfer (cluster -> phone)

Dex-verified (`handleDocTransferFrame` checks data[1] == 0x54). Doc
transfer is not implemented; frames are counted as known, never decoded.

## 4. Outbound frame IDs (phone -> cluster)

The app builds these; the simulator must parse and display them (or
emulate the cluster response).

### 0x4A Mobile data / keepalive (20 bytes, dex-reconciled)

| Byte(s) | Field |
|---------|-------|
| 0 | 0x5B |
| 1 | 0x4A |
| 2 | signal (1-5, upper nibble) \| phone battery bucket 1-4 (lower nibble; bucket = ceil(batteryPercent / 25)) |
| 3 | overspeed limit: 120 default for Jupiter (70 Zest); when the user's overspeed alert is ON, the user's 40..70 setting |
| 4 | ambient temp + 40, coerced to [-128, 127] (official app sends 40 when unknown, i.e. 0 C) |
| 5 | 0x00 |
| 6-9 | time: hour (12H, 1-12), minute, second, AM/PM (0 = AM, 1 = PM). MUST stay here: the cluster reads the clock at these bytes; an earlier build moved the time block and every connect set the cluster clock to 12:04 |
| 10 | missed calls |
| 11 | network type (e.g. 4 = LTE) |
| 12-14 | date: day, month (1-12), year % 100 |
| 15 | 0x00 |
| 16 | 0x00 for Jupiter (voiceAssist packed byte is Ntorq-gated) |
| 17 | find-me: 1 for ~10 packets after trigger, else 0 (triggers scooter buzzer/lights) |
| 18 | checksum (section 2) |
| 19 | 0xFF |

The phone-local time is always sent (the cluster has no timezone field).

### 0x4C / 0x63 Custom text rows (2 x 17 chars)

* Row 1: `5B 4C <up to 17 bytes> 00-pad FF` (20 bytes).
* Row 2: `5B 63 <up to 17 bytes> 00-pad FF` (20 bytes).
* Sanitization (official-app parity, dex-verified): emoji/symbols become
  `@`, any char outside `[A-Za-z0-9 space @]` becomes `X`, trimmed,
  truncated to 17 UTF-8 bytes without splitting a multi-byte char.
* Longer notifications paginate into 17-char pages, cycled ~3 s.
* Blank lines are skipped when updating a single line (so the other line
  is not blanked).

### 0x52 Rider-name registration

`5B 52 <name up to 17 bytes> 00-pad FF` (20 bytes). Same sanitization
and padding as the text rows. JupiterPlus `buildRegistrationPacket`
parity; only the RE doc's 0x4C/0x63 text is in the RE doc, so the 0x52
framing is builder-verified but cluster-acceptance UNVERIFIED on device.

### 0x5A 0x4E Navigation control

`5A 4E dist(2) eta(2) remaining(3) pictogram lineCount navStatus ... FF`
(20 bytes). NOTE: byte 0 on the wire is 0x5A (Dart: jupiter_navigation
buildNavControlFrame, packet[0] = JupiterId.navControl0), NOT 0x5B;
nav-text (0x4F) keeps the 0x5B lead. Corrected 2026-09-30.

| Byte(s) | Field |
|---------|-------|
| 0 | 0x5A |
| 1 | 0x4E |
| 2-3 | distance to maneuver, meters, BE UInt16 (clamped 0..65535) |
| 4-5 | ETA, minutes, BE UInt16 |
| 6-8 | remaining trip, meters, BE UInt24 |
| 9 | pictogram (maneuver catalog below) |
| 10 | row count, 1 or 2 |
| 11 | nav status: 0x01 (stock resolves 0x01 on every Jupiter-family branch; arrival/stop are conveyed by zeroed/custom frames, never a distinct status byte) |
| 12-18 | 0x00 (padding) |
| 19 | 0xFF |

Remaining framing detail beyond these bytes is UNVERIFIED; confirm on
hardware before relying on it.

Maneuver catalog (exhaustive per NAVIGATION_ARCHITECTURE.md):
0 = Sharp left, 1 = Slight left (alt), 2 = Slight left, 3 = Sharp right,
4 = Slight right (alt), 5 = Slight right, 6 = U-turn left, 7 = Go
straight, 8 = Arrived, 11 = T-junction L, 12 = T-junction R,
13 = Left branch, 14 = Right branch, 15 = Fork left, 16 = Fork right,
17 = Merge left, 18 = Merge right, 19 = Exit left, 20 = Exit right,
21 = Crossroad, 40 = No entry, 41 = U-turn right, 65 = Rbt slight left,
66 = Rbt sharp left, 67 = Rbt slight right, 68 = Rbt straight,
69 = Rbt right, 70 = Rbt sharp right, 71 = Rbt U-turn (India left-hand
roundabouts), 82-88 = right-hand roundabout set.

### 0x4F Navigation text (20 bytes)

`5B 4F <text up to 17 bytes> 00-pad FF`. Padding is 0x00, NOT 0xFF
(0xFF inside the text region decodes as garbage glyphs on the cluster).
Stock hard-cuts 17 chars with no sanitization; Scoot additionally
sanitizes (ASCII fallback) and prefers a word boundary.

### 0x43 Caller info (three-packet sequence, dex-verified)

Each packet: `5B 43 subId <UTF-8 text> 00-pad to 17 chars FF`.
Order sent by stock: sub 0x01 (national number, e.g. "9424502823"),
then sub 0x03 (country code digits, e.g. "91"), then sub 0x02 (contact
name, only when non-empty). Pad length is computed from
`String.length()` (chars) while text is UTF-8 encoded, so non-ASCII
text can make the packet longer than 20 bytes; mirror that behavior.

### 0x50 Pictogram

`[5B, 50] + UTF-8 name + zero pad to 17 chars + [FF, 00]`. The two-byte
`[FF, 00]` tail is verbatim from the dex (not a single 0xFF).

### 0x61 / 0x62 / 0x65 Music metadata (always 20 bytes)

`[5B, dataId] + UTF-8 text (truncated to 16 bytes) + [FF] + zero pad +
[00]`. The dataId -> field mapping (0x61 title, 0x62 artist, 0x65
album) is UNVERIFIED; truncation is byte-level and can split a
multi-byte char, as in the dex.

### 0x22 First-connection user ID (always 20 bytes)

`[5B, 22] + big-endian userId (+ 0x00 prefix when <= 2 bytes, mirroring
BigInteger.toByteArray sign handling and the dex short-body prepend) +
0xFF pad + [FF]`. Padding is 0xFF, NOT 0x00 (dex-verified per
tvs-addendum F1; contradicts the Dart, which zero-pads). Payload is the
app account's numeric user ID; whether Jupiter expects it at all is
UNVERIFIED. Scoot never sends it automatically. Sent by the phone
shortly after connect (tvs-addendum F2), so the sim accepts any.

### 0x53 SMS notification

`[5B, 53] + UTF-8 text + zero pad to 17 chars + [FF]`. MODEL-GATED in
the real app: sent only for U388/iQube variants, never for Jupiter.
Provided for completeness; not exposed on the Jupiter session.
UNVERIFIED on Jupiter hardware.

### 0x5A 0xF1 Vehicle control (cluster brightness, dex-verified)

Start byte is 0x5A on the wire here:

| Byte(s) | Field |
|---------|-------|
| 0 | 0x5A |
| 1 | 0xF1 |
| 2 | brightness wire byte: level 1 -> 1, levels 2-5 -> level * 2 (level clamped 1-5) |
| 3 | 9 |
| 4 | 0x00 |
| 5 | 2 |
| 6-8 | 0x00 |
| 9 | phone day |
| 10 | 0x00 |
| 11 | phone month - 1 (0-based) |
| 12 | 0x00 |
| 13 | phone year & 0xFF |
| 14 | 0x00 |
| 15 | 1 |
| 16 | 0x01 |
| 17-18 | 0x00 |
| 19 | 0xFF |

### 0x73 Calibration (experimental, byte layout dex-verified)

`[5B, 73, b2, b1, 04, value LE32, checksum, 00 x9, FF]`, checksum at
byte 9 = `(256 - (sum(bytes[2..8]) % 256)) & 0xFF`.

Command bytes (b1): 18 = follow-me-home headlamp timer, 23 = TSL
auto-cancel timer, 9 = idle start-stop timer. Cluster acceptance is
UNVERIFIED until a live BLE capture on real hardware validates it.

Alternate follow-me encoding (dex-verified
`updateFollowMeHeadlampTimer`, kept for the live test if the
calibration path does nothing): `[5B, 73, 0A, 12, 02, 00, 00, hi, lo,
cksum, 00 x9, FF]` where hi/lo are the big-endian halves of the timer
in seconds and cksum = 0x3D if lo == 16, 0x74 if lo == 32, else 0xAB.

## 5. Session lifecycle

Sequence the simulator relay must emulate (JupiterPlus parity):

1. SCAN. The app may scan filtered by service UUID or unfiltered
   (15 s sweep). Filtered scanning hides scooters that expose GATT
   without advertising the UUID; the Connect UI uses unfiltered and
   ranks hints (name containing "jupiter"/"tvsbt"/"tvs", or the service
   UUID) in Dart. Name is a hint only, never proof.
2. CONNECT to the device id. MTU 515 requested on Android, bounded to
   2 s; failure never blocks the session.
3. DISCOVER services, bounded to 12 s. VERIFIED-OPEN GATE: connect is
   refused unless discovery contains the Jupiter service UUID AND both
   characteristics. Primary resolution: exact service-UUID match (chars
   mandatory). Fallback: any service exposing BOTH the write and notify
   characteristic UUIDs (the characteristics are the true protocol
   fingerprint; a variant cluster that moves the service UUID still
   resolves). If the exact service UUID is present but chars are
   missing, that is a hard failure, not a fallback.
4. SUBSCRIBE: the app listens on the notify value stream BEFORE calling
   setNotify(true), because the scooter can emit the 0x9A 0xF2
   challenge immediately upon CCCD write and events in between would be
   lost.
5. AUTH phase: the app waits up to 10 s for a 0x9A 0xF2 challenge
   (detect only, never answered). See section 7.
6. KEEPALIVE: the 0x4A mobile-data ping loop starts immediately on open
   (an immediate kick, then every 2 s). Parked scooters (ignition OFF)
   only respond to this; ride telemetry additionally needs ignition ON.
   Writes are serialized through a single future-chain: the Android
   stack is not thread-safe and parallel writes cause Status 133
   disconnects.
7. READY: parked-level ready = verified GATT + subscribed notify +
   auth attempted + ping flowing. Ride-level ready (LIVE UI gate) needs
   the first 0x10/0x11/0x18/0x19 frame. Stale-link watchdog: no rx for
   10 s (checked every 5 s) emits degraded; any live frame clears it.
   RSSI polled every 15 s.
8. CLOSE / RECONNECT: close tears down the notify subscription, write
   chain, ping loop, nav refresh and paged text; the device id is kept
   for "Reconnect last". Unexpected drops start an auto-reconnect loop:
   immediate first attempt, then backoff 5/10/20/40/60/60... seconds,
   max 10 attempts, then the session emits closed (which ends the trip
   and lets the parked pin fire). The cluster forgets vehicle settings
   on disconnect, so every reconnect re-applies them and restarts the
   ping loop.

## 6. Timing constants

| Stream | Cadence | Notes |
|--------|---------|-------|
| Telemetry 0x10/0x11/0x18/0x19 | ~20 ms (real) | ~50 Hz |
| Button gesture gap threshold | > 200 ms stall = held stream; 200-550 ms gap = tap, > 550 ms = hold; taps within 350 ms coalesce into single/double/triple/long combos |
| 0x4A keepalive ping | every 2 s | provisional (RE mandates "continuously" without a period); immediate kick on open; in-flight guard so a stalled write never piles up pings |
| Nav control 0x5A4E HUD keepalive | every 1 s | the cluster drops the nav screen when control frames stop; the official app streams at ~1.5 s |
| Text page cycle | 3 s | long messages paginate 17-char pages, alternating 0x4C/0x63 |
| Nav instruction burst pacing | 200 ms between frames | text frame first, then control frame; newer instructions supersede pending ones |
| Auth challenge wait | 10 s timeout | detect only |

## 7. Auth challenge (detect-only)

* The scooter may send `0x9A 0xF2` + 16-byte challenge (payload >= 18
  bytes; the parse reads bytes 2..17). This is NOT the 20-byte frame
  framing and must be checked before the size gate, otherwise every
  challenge is dropped.
* The 0x9A/0xF2 challenge and the 0xF1 response belong to the
  keyless-entry (vehicle-control) channel, which Scoot does not
  implement per the standing safety rule. The app only detects the
  challenge for diagnostics. It never builds or sends a response.
* The published RE-report key bytes exist in code only as a documented
  constant for AES-128-CTR primitive tests and never go on the wire;
  do not document the key value here or anywhere else.

## 8. 110 vs 125 differences

The 125 rides on the same v1 protocol stack (single Jupiter
cluster-data path in the dex); no separate byte maps. The only
protocol-relevant decode difference is the 0x10 byte-6 fuel rule
(section 3, 0x10): 125 applies the low-nibble extraction
(`raw & 0x0F`), 110 passes the raw byte through. Capabilities and the
session flow are identical.

## 9. Ntorq deltas (not emulated by this sim, documented for the app)

* Same service UUID family, but every OUTGOING frame is XOR-masked with
  0xEB in the app (bytes 0-1 untouched, trailing byte forced 0xFF); the
  Jupiter path skips masking. Inbound dispatch accepts 0x5A or 0x9B.
* Writes use WRITE_TYPE_DEFAULT (with response); autoConnect is false.
* NO keep-alive ping loop on Ntorq (the cyclic mobile-data layout is
  UNVERIFIED in the dex, so Scoot sends nothing cyclically).
* NO auth-challenge handling (the Ntorq AES keyless path is never
  answered, standing safety rule).
* Extra inbound IDs on Ntorq: 0x37 (calibration response, parsed for
  capture), 0x29 (WiFi password frame, counted as known, never
  decrypted/decoded here). Music command map 0-6 is the same as
  Jupiter's. Ntorq 0x10 byte-12 accept/reject values are UNVERIFIED.
* Ntorq battery voltage comes from the 0x18 byte 11 x0.1 path,
  same as Jupiter (corrected 2026-09-30 per W2: the 0x11 byte 6 path
  was wrong).

## 10. UNVERIFIED items (do not assert in tests or UI)

1. 0x10 byte 2 speed mapping (PROVISIONAL; needs HCI capture).
2. 0x10 odometer km = raw / 10.0 (big-endian 24-bit is dex-verified;
   the /10 scale is provisional).
3. Cluster fuel-bar and reserve readings (Scoot interpretation; the
   110 upper-nibble-reserve rule is provisional until an on-bike check).
4. 0x10 byte 8 ECO/POWER and byte 11 street/sport decodes: dex-annotated
   but dead code in the stock app; Scoot surfaces them as its own
   feature.
5. 0x61/0x62/0x65 dataId -> title/artist/album mapping.
6. Nav control frame bytes 12-18 and remaining framing beyond the
   documented fields.
7. 0x52 registration acceptance by the real cluster.
8. 0x53 SMS frames on Jupiter hardware (model-gated to U388/iQube in
   stock; never sent to Jupiter).
9. 0x73 calibration cluster acceptance (follow-me / TSL / ISS timers).
10. 0x22 user-ID frame expectations on Jupiter.
11. The purpose of the alternate inbound start byte 0x9B (accepted,
    never emitted).
12. Trip-reset and tyre-pressure builder frames: no such builders exist
    in the Scoot sources. Nothing is documented for these; do not invent
    frames for them.
