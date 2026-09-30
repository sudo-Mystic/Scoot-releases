# TVS xConnect research addendum (independent second source)

Worker W2 (tvs-crosscheck), 2026-09-30. This file is the DELTA between the
Scoot Dart implementation (`~/workspace/projects/scoot/lib/vehicles/tvs_jupiter/`)
and the TVS xConnect v8.12.4 reverse-engineering research in
`~/workspace/research/tvs-xconnect-app/`. It covers only what the Dart code
does not already contain, plus explicit contradictions. W1's PROTOCOL.md
(from the Dart sources) is the primary reference; each finding names the
PROTOCOL.md section it amends.

Confidence tags: CONFIRMED (seen in a capture note or verified at the dex
bytecode level this session) or UNVERIFIED (inferred, untraced, or absent
from the research).

Safety boundary respected throughout: keyless-entry crypto is noted by
existence and location only. No key material was extracted or reproduced,
and no 0x9A/0xF2/0xF1 challenge-response construction is documented.

---

## F1. 0x22 user-ID frame: pad fill contradicts the Dart code

- Amends: PROTOCOL.md section on the 0x22 first-connection user-ID frame.
- Dart behavior (`jupiter_text.dart`, `buildUserIdFrame`): `[5B, 22] + userId
  bytes (+ 0x00 prepend when 2 or fewer bytes) + zero pad + [FF]`, 20 bytes.
- Dex behavior (`BlePacketsProvider.byteArrayForFistConnection`,
  `work/dex/classes10.dex`): `[5B, 22] + idBytes + 0xFF pad + [0xFF]`.
  Details, read from bytecode this session:
  - Header is the 2-byte fill-array `[0x5B, 0x22]`.
  - User ID is `BigInteger.valueOf(userId).toByteArray()`; a single `0x00`
    byte is prepended iff `toByteArray().length <= 2`. (This prepend
    condition MATCHES the Dart; only the pad differs.)
  - The pad is filled with `0xFF` (`ArraysKt.x` fill with byte `-1`), length
    `20 - (idLen + 3)`, and then one final single `0xFF` byte is appended,
    for a total of exactly 20 bytes. There is no zero pad and no separate
    checksum byte; the trailing `0xFF` bytes are padding, not a terminator.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`,
  class `Lcom/tvs/bluetooth/core/utils/BlePacketsProvider;`,
  method `byteArrayForFistConnection(Ljava/math/BigInteger;)[B`.
- Confidence: CONFIRMED.
- CONTRADICTION: the Dart pads with `0x00`; the real app pads with `0xFF`.
  If the sim validates 0x22 frames from a client, or if Scoot ever sends
  one, the pad bytes must be `0xFF`.

## F2. 0x22 sequencing: phone writes it on connect from the account DB

- Amends: PROTOCOL.md connection/auth sequencing section.
- `BaseBleConnectHelperService.validateUserID()` reads the app account's
  numeric user ID from the local database (`GetUserDataFromDBUseCase` ->
  `UserData.getUserId()` -> `BigInteger.valueOf`), builds the 0x22 frame via
  `byteArrayForFistConnection`, and writes it through `BleEngine`. It is
  invoked from `observeConnectionState`, i.e. on GATT connection-state
  changes. Log marker: `"BT-BLE Control : User Id Array "`.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`,
  class `Lcom/tvs/ble/feature/services/BaseBleConnectHelperService;`
  (`validateUserID`, `observeConnectionState$1$2`).
- Confidence: CONFIRMED for the write-on-connect behavior. UNVERIFIED
  whether it fires on every connect or only the first pairing (no
  first-connect preference gate was found in the method body).
- For the sim: expect a 0x22 frame from the phone shortly after connect;
  the payload is an arbitrary account ID, so the sim should accept any.

## F3. Cluster frames are only parsed after the phone's first write

- Amends: PROTOCOL.md connection/auth sequencing section.
- `BleEngine.parseDataBikeWise` routes cluster frames to the receiver only
  when `isFirstCyclicDataSent()` is true. `setFirstCyclicDataSent(true)` is
  called from the `writeCharacteristicToCentral` coroutine continuations
  (after a 100 ms delay), and reset to false on disconnect or connection
  failure (`centralManagerCallback$1`). In practice the gate opens after
  the phone's first successful write, which is the cyclic 0x4A mobile-data
  packet.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BleEngine`, `isFirstCyclicDataSent`/`setFirstCyclicDataSent`,
  `writeCharacteristicToCentral$1$1`, `centralManagerCallback$1`);
  `~/workspace/research/tvs-xconnect-app/model-gating-verification.md`.
- Confidence: CONFIRMED for the phone-side gate. UNVERIFIED (inferred) that
  the real cluster mirrors this and withholds its telemetry stream until it
  has received the phone's first packet. For the sim: do not be surprised
  if a real cluster stays silent until the phone writes; a faithful sim may
  gate its 0x10/0x11/0x18/0x19 stream on receiving the client's first
  0x4A.

## F4. 0x54 doc-transfer request: byte layout now available

- Amends: PROTOCOL.md section on the 0x54 doc/image-transfer frame (Dart
  currently counts it as known but does not decode it).
- Cluster -> phone 0x54 layout, from `BLEImageTransferUtils`:
  - `getPicNo([B)`: byte[2] is the picture/document number.
  - `getFrameNO([B)`: bytes[5] and [6] are a big-endian 16-bit frame number
    (`new BigInteger(new byte[]{b[5], b[6]}).intValue()`).
- Purpose is caller-profile-image sync (`initCallerProfileImageTransfer`,
  `retrieveContactPhoto`, triggered around incoming calls) and wallpaper
  sync (`WallPaperUseCase`, `getUpdateSyncEventWalPaper`), plus generic
  documents via `DocTransferHandler`/`DocumentStorageUseCase`. On Jupiter,
  `parseData` routes 0x54 to log `"SPEEDOMETER_DATA_5A_54_FRAME"` plus a
  callback into `BleEngine.observeDocTransferFromCluster`; no per-variant
  gating (identical for the 110, 125, and U745).
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`Lcom/tvs/ble/feature/utils/BLEImageTransferUtils;`: `getPicNo`,
  `getFrameNO`); `~/workspace/research/tvs-xconnect-app/model-gating-verification.md`.
- Confidence: CONFIRMED.
- For the sim: a 0x54 frame with `[2]=picNo, [5..6]=frameNo` is the
  cluster requesting image data; the app answers with 0x55 chunks (F5).

## F5. New frame ID 0x55: image-chunk transfer (phone -> cluster)

- Amends: PROTOCOL.md frame-ID table (0x55 is absent from the Dart).
- `BLEImageTransferUtils.byteArrayForImageTransfer(chunkBytes, frameNo)`
  builds: `[5A, 55] + frameNoBytes + chunkBytes + [00, FF]`.
  - Frame-number encoding: if `frameNo > 255`,
    `BigInteger.valueOf(frameNo).toByteArray()`; otherwise two bytes
    `{0x00, (byte) frameNo}` (big-endian).
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BLEImageTransferUtils.byteArrayForImageTransfer`).
- Confidence: CONFIRMED.
- For the sim: the sim (as cluster) never sends 0x55, but a complete sim
  may want to accept and log 0x55 chunks if it initiates a 0x54 request.

## F6. New frame ID 0x53 (init image transfer, phone -> cluster)

- Amends: PROTOCOL.md frame-ID table and the 0x53 SMS note.
- `BLEImageTransferUtils.byteArrayForInitImageTransfer(...)` builds a frame
  with the 2-byte header `[0x5A, 0x53]` (payload carries the picture-name
  strings; full layout not traced in this pass).
- Caution: `0x53` collides with the SMS-notification frame ID, which the
  Dart correctly marks as model-gated to U388/iQube. The init-image-transfer
  0x53 is a different payload shape on the same ID; the two are
  distinguished by direction-independent context the dex does not make
  explicit here.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BLEImageTransferUtils.byteArrayForInitImageTransfer`).
- Confidence: CONFIRMED for the header bytes. UNVERIFIED for the full
  payload layout and for which models use it.

## F7. Image-transfer model gating (Jupiter-relevant)

- Amends: PROTOCOL.md model-gating section.
- `getSubByteArraySize(BikeType)`: `U_577_BASE` or `JUPITER_U566`
  (Jupiter 125) -> 173 bytes per image chunk; every other bike type -> 128.
  Verified by branch-target analysis of the method bytecode.
- Caller-image sync applies to Jupiter: `nonCallerImageSyncBikeTypes` is
  exactly `{U_347, U_347_UG, U_347_UG_PLUS, U388, U347_GEN_3, U702, U_759,
  IKARUS, U829_A, U829_B}`; no Jupiter variant (`JUPITER_U279`,
  `JUPITER_U566`, `JUPITER_U745`) is in the set.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BLEImageTransferUtils`: `getSubByteArraySize`, `<clinit>`,
  `isCallerImageSync`).
- Confidence: CONFIRMED.
- For the sim in 125 mode: use 173-byte image chunks if emulating the
  0x54/0x55 exchange.

## F8. New frame ID 0x60: play/pause-state (phone -> cluster)

- Amends: PROTOCOL.md frame-ID table (0x60 is absent from the Dart).
- `BlePacketsProvider.returnPlayPauseState(String, int)` builds a 20-byte
  frame: `[5B, 60, 00, currentHour, 00, 00, 00, stateByte, 00 x 11, FF]`.
  The `int` argument is the play/pause state byte at index 7; index 3 is
  the current hour (`getCurrentHour`).
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BlePacketsProvider.returnPlayPauseState`).
- Confidence: CONFIRMED for the builder and layout. UNVERIFIED for the
  state-byte values and for Jupiter applicability:
  `BleMusicDataSourceImpl.writeMusicDataToCluster` dispatches among
  `returnPlayPauseState`, `returnPlayPauseStateApache`, and
  `returnPlayPauseStateU577` per bike type, and the Jupiter branch was not
  traced in this pass.

## F9. 0x6B music-command map: independent verification, no delta

- Amends: nothing; cross-check only.
- Bytecode read of `BluetoothUtil.getMusicCommandType(byte)` this session
  matches the Dart's `decodeMusicCommand` exactly: command byte at frame
  index 2; `0` -> Play, `1` -> Pause, `2` -> Toggle, `3` -> Next,
  `4` -> Previous, `5` -> Volume up, `6` -> Volume Down, anything else ->
  empty. `processMusicControlsUseBtData` reads the command from
  `getData()[2]` and additionally drives `AudioManager` (volume keys 5/6 ->
  `adjustStreamVolume`, 0/1 -> play/pause key events, 3 -> KEYCODE_MEDIA_NEXT
  87, 4 -> KEYCODE_MEDIA_PREVIOUS 127).
- The map itself has no model gating, but in stock only Ntorq wires it;
  Jupiter's `parseData` routes 0x6B to `handleOtherFrames` (log only).
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`BluetoothUtil`: `getMusicCommandType`, `processMusicControlsUseBtData`).
- Confidence: CONFIRMED. No contradiction with the Dart.

## F10. Jupiter phone->cluster send paths absent from the Dart

- Amends: PROTOCOL.md phone->cluster section (coverage note, not byte detail).
- `JupiterMobileToCluster` (the Jupiter sender the Dart does not model)
  contains these additional send paths, all confirmed present in the dex,
  none traced to bytes in this pass:
  - `sendWeatherData` / `sendWeatherScreenAndWeatherData` (periodic
    weather + AQI; log line shows a firebase-event skip flag for weather),
    `getPeriodicWeatherCricketData`
  - `sendCricketData` / `sendCricketScreenAndCricketData`,
    `sendFootballData`, `sendNewsData` / `sendClimateNews`
  - `sendTrafficSequence`, `sendCustomTextLineForTrafficSequence`,
    `sendCustomTextLineOne`, `sendCustomTextLineTwo`
  - `sendDestReachedCustomText` / `createDestReachedArray`
  - `sendTslByte`, `turnOffTSL`
  - `sendFollowMeHeadLampTimer`, `sendFollowMeHeadLampTimerU577`
  - `updateVehicleSettings` / `setVehicleSettingsModel` /
    `sendVehicleSettingsModel`
- Also in `BlePacketsProvider`, untraced for Jupiter: `returnInitialMobilePacket`
  (2-byte header `[0x5B, 0x4A]`, a mobile-data variant), `returnVIN`,
  `sendVehicleMode`, `sendVehicleTimerControl`.
- Source: `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
  (`Lcom/tvs/ble/feature/datasender/JupiterMobileToCluster;`,
  `BlePacketsProvider`).
- Confidence: CONFIRMED for existence. UNVERIFIED for frame IDs, payloads,
  and cadence.
- For the sim: these are all phone->cluster, so they need no cluster-side
  emulation; they are listed so PROTOCOL.md can mark them out of scope
  rather than unknown.

## F11. Research gaps (no contradiction; the research is silent)

- Cluster text paging/cycle: the TVS research contains nothing about text
  paging behavior or a 3 s page cycle. The Dart's 3 s cycle and 17-char
  pages come from the third-party RE report, not the TVS dex. UNVERIFIED
  from this source.
- Timing/cadence from real captures: the TVS research is static analysis
  only; there are no live-capture timing notes. The 20 ms telemetry
  cadence and ~1.5 s nav-control streaming figures are RE-report sourced.
  The single dex timing datum found: 100 ms delay before
  `setFirstCyclicDataSent(true)` (F3).
- 0x52 rider-name registration: no 0x52 builder exists in
  `BlePacketsProvider` and no research doc mentions 0x52. The Dart's
  `buildRegistrationPacket` is JupiterPlus/RE-report parity marked
  "validate on device". Neither confirmed nor contradicted by this
  research.
- Music metadata 0x61/0x62/0x65 field mapping (title/artist/album): still
  UNVERIFIED; the Dart already marks it so. No delta.
- GATT characteristic UUIDs `00005352-...` / `00005354-...`: not covered in
  the TVS research docs (they come from the RE report); the service UUID
  `5456534D-...` matches `ble-telematics.md` section 2.

## F12. Safety-boundary note (keyless entry)

- The keyless-entry channel is referenced here by existence and location
  only, matching the level the Dart already documents in
  `jupiter_auth.dart`:
  - Hardcoded 16-byte AES key: `KeylessEntryUtils.AES_KEY_BYTE_ARRAY`
    (set in `<clinit>`, mutable via setter), at
    `com/tvs/bluetooth/core/utils/KeylessEntryUtils`. Key value redacted
    per policy; it was not extracted in this pass.
  - Challenge write path: `BleEngine.writeChallenge`.
  - Shared command-frame builder: `BlePacketsProvider.byteArrayForUnLock`
    (used for lock, unlock, trunk-open, find-vehicle).
  - Command UUIDs for LOCK/UNLOCK/OPEN_TRUNK/FIND_VEHICLE are listed in
    `ble-telematics.md` section 2.
- No challenge-response construction is documented here, and none is
  needed: the sim is telemetry/display/mirroring only.
- Sources: `~/workspace/research/tvs-xconnect-app/ble-telematics.md`,
  `~/workspace/research/tvs-xconnect-app/auth-crypto.md` (section 8),
  `~/workspace/research/tvs-xconnect-app/tvs-connect-master-report.md`
  (sections 5.2, 7).

---

## Method note

Findings F1, F2, F4-F9 were verified at the Dalvik bytecode level this
session against `~/workspace/research/tvs-xconnect-app/work/dex/classes10.dex`
using androguard 4.1.4 from the research venv (no app code modified, read-only
analysis). F3, F10 draw on the same dex plus `model-gating-verification.md`.
F11 records what the research does not contain. The remaining research docs
(`ble-telematics.md`, `auth-crypto.md`, `tvs-connect-master-report.md`) were
mined for cluster behaviors and contributed the scan/bonding notes, the
model-gating verdicts, and the keyless-entry locations.
