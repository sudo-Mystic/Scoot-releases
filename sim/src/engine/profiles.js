// Vehicle profiles for the Scoot Scooter Simulator.
//
// Zero dependencies, no DOM. Each profile describes the model-specific byte
// behavior the simulator engine needs: the 0x10 fuel-byte encode/decode,
// the GATT UUIDs, and the inbound telemetry cadence.
//
// Profile interface (implemented exactly as specified in the task; the
// engine module sim/src/engine/engine.js does not exist yet, so it will be
// written against this shape):
//   {
//     id,                 // string: profile key
//     label,             // string: display name
//     encodeFuelByte(level01), // number 0..1 -> wire byte for 0x10 byte 6
//     decodeFuelByte(byte),    // wire byte -> number 0..1
//     serviceUuid,       // GATT service UUID (lowercase)
//     writeUuid,         // write characteristic UUID (lowercase)
//     notifyUuid,        // notify characteristic UUID (lowercase)
//     frameCadenceMs,    // { dataId: ms } for the 0x10/0x11/0x18/0x19 streams
//     notes,             // verification notes, per-byte source citations
//   }
//
// Extra (non-interface) fields the engine may consume are kept under the
// `extras` key so the core interface stays exactly the specified shape.
//
// No em dashes are used in any writing in this file.
'use strict';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

// All three models share the same GATT UUIDs. ASCII "TVSM-VG-SA-SB-ENTORQ"
// service, "SR" write, "ST" notify. Verified:
//   jupiter_constants.dart (class JupiterBle, service/write/notify consts)
//   ntorq_constants.dart (class NtorqBle, service/write/notify consts)
const SERVICE_UUID = '5456534d-5647-5341-5342-454e544f5251';
const WRITE_UUID = '00005352-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '00005354-0000-1000-8000-00805f9b34fb';

// 0-15 fuel gauge steps shared by the low-nibble models (Jupiter 125 and
// Ntorq both decode the 0x10 fuel byte as raw & 0x0F, CONFIRMED dex).
const FUEL_STEPS = 15;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// jupiter110: TVS Jupiter 110 (U279/U745) - baseline
// ---------------------------------------------------------------------------
// Fuel byte rule: the stock app passes the raw 0x10 byte 6 through
// untouched on the 110. Verified in jupiter_telemetry.dart, decodePrimary
// ({bool jupiter125 = false}): the else-branch sets fuelLevel = fuelRaw
// and the provisional reserve reading is (fuelRaw & 0xF0) != 0, i.e. the
// upper nibble carries the reserve flag, never a bar value.
// Gate flag: jupiter_ble_session.dart `_modelVariant125` (default false);
// the 110 never sets it.
const jupiter110 = {
  id: 'jupiter110',
  label: 'TVS Jupiter 110 (U279/U745)',
  encodeFuelByte(level01) {
    const bars = Math.round(clamp01(level01) * FUEL_STEPS); // 0..15
    // Upper nibble set as the reserve flag when the tank is low. This is a
    // SIM CONVENTION mirroring jupiter_telemetry.dart's provisional rule
    // (reserve = upper nibble nonzero). The real reserve threshold is
    // UNVERIFIED (PROTOCOL.md section 10 item 3).
    const reserve = level01 < 0.15;
    return (bars & 0x0f) | (reserve ? 0x80 : 0x00);
  },
  decodeFuelByte(byte) {
    // Stock passes the raw byte through; Scoot's provisional bars
    // interpretation reads the low nibble as the bar count.
    return (byte & 0x0f) / FUEL_STEPS;
  },
  serviceUuid: SERVICE_UUID,
  writeUuid: WRITE_UUID,
  notifyUuid: NOTIFY_UUID,
  // 0x10/0x11/0x18/0x19 all ~20 ms on the real cluster. Verified:
  // jupiter_constants.dart (JupiterTiming.telemetryIntervalMs = 20) and
  // sim docs PROTOCOL.md section 6.
  frameCadenceMs: { [0x10]: 20, [0x11]: 20, [0x18]: 20, [0x19]: 20 },
  notes: [
    'Fuel byte: raw pass-through on the 110 (jupiter_telemetry.dart, decodePrimary else-branch; jupiter125_adapter.dart notes stock passes raw on U279/U745).',
    'encodeFuelByte puts 0-15 bars in the low nibble and sets the upper nibble as a reserve flag below 15% (sim convention; jupiter_telemetry.dart reserve rule is provisional/UNVERIFIED, PROTOCOL.md section 10 item 3).',
    'UUIDs: jupiter_constants.dart (JupiterBle). Lowercase per the FBP normalization note there.',
    'No outbound masking; write-without-response (jupiter path in ntorq_crypto.dart routing comment, BleEngine.writeCharacteristicToCentral).',
    'Auth 0x9A/0xF2 challenge: detect-only, never answered (standing safety rule; PROTOCOL.md section 7).',
  ],
  extras: {
    outboundXorMask: 0, // no masking on the Jupiter path
    writeWithResponse: false,
    keepalivePing: true, // 0x4A mobile-data ping every 2 s
    authChallengeExpected: true, // detect-only
    modelVariant125Gate: false,
    inboundIds: [0x10, 0x11, 0x18, 0x19, 0x6b, 0x54],
    unverified: [],
  },
};

// ---------------------------------------------------------------------------
// jupiter125: TVS Jupiter 125 (U566) - low-nibble fuel decode
// ---------------------------------------------------------------------------
// The ONLY verified protocol delta vs the 110: the stock app applies
// int2bytes to the 0x10 fuel byte when the bike is JUPITER_U566, which is a
// LOW-NIBBLE extraction (0x3C -> 12, 0x35 -> 5, 0x80 -> 0; exactly
// raw & 0x0F). Verified in jupiter_telemetry.dart decodePrimary
// (jupiter125: true branch) and jupiter125_adapter.dart
// (Jupiter125V1Adapter.live sets session.modelVariant125 = true;
// comment cites handleSpeedOMeter, dex-verified 2026-09-25).
//
// The 125 rides on the same v1 protocol stack (single Jupiter
// cluster-data path in the dex); capabilities and session flow are
// identical (jupiter125_definition.dart header; PROTOCOL.md section 8).
// The modelVariant125 gate is set by the adapter from the user's vehicle
// selection, NOT derived from the 0x11 theme/model bytes on-air
// (jupiter125_adapter.dart liveJupiterAdapterFor).
const jupiter125 = {
  id: 'jupiter125',
  label: 'TVS Jupiter 125 (U566, SmartXonnect v1)',
  encodeFuelByte(level01) {
    // The cluster only needs the low nibble; stock ignores anything else
    // in this byte on the 125. Upper nibble zeroed on encode.
    return Math.round(clamp01(level01) * FUEL_STEPS) & 0x0f;
  },
  decodeFuelByte(byte) {
    return (byte & 0x0f) / FUEL_STEPS;
  },
  serviceUuid: SERVICE_UUID,
  writeUuid: WRITE_UUID,
  notifyUuid: NOTIFY_UUID,
  // Same cadence as the 110: no 125-specific timing was found in the dex
  // or the Scoot sources (PROTOCOL.md section 8: capabilities and session
  // flow identical).
  frameCadenceMs: { [0x10]: 20, [0x11]: 20, [0x18]: 20, [0x19]: 20 },
  notes: [
    'Fuel byte: LOW-NIBBLE extraction on the 125 (raw & 0x0F), dex-verified handleSpeedOMeter gated on JUPITER_U566 (jupiter_telemetry.dart decodePrimary jupiter125 branch; jupiter125_adapter.dart).',
    'Reserve is always false on the 125: no upper nibble survives the gate (jupiter_telemetry.dart).',
    'No other 125 byte differences found: single Jupiter cluster-data path in the dex; the 125 adapter inherits the 110 session unchanged (jupiter125_adapter.dart header; jupiter125_definition.dart).',
    '0x11 byte 14 (cluster theme, theme 2 = Jupiter 125 per jupiter125_adapter.dart comment) and byte 9 (vehicle model numeric) are surfaced raw and never used for gating; the 125 gate comes from the user vehicle selection (jupiter125_adapter.dart liveJupiterAdapterFor).',
    'UUIDs identical to the 110 (jupiter_constants.dart).',
    'UNVERIFIED: 0x10 telemetry byte positions against a real 125 cluster (jupiter125_adapter.dart TODO).',
  ],
  extras: {
    outboundXorMask: 0,
    writeWithResponse: false,
    keepalivePing: true,
    authChallengeExpected: true,
    modelVariant125Gate: true,
    inboundIds: [0x10, 0x11, 0x18, 0x19, 0x6b, 0x54],
    unverified: ['0x10 telemetry byte positions on a real 125 cluster'],
  },
};

// ---------------------------------------------------------------------------
// ntorq: TVS Ntorq 125 (SmartXonnect U_716)
// ---------------------------------------------------------------------------
// The Ntorq protocol is largely the same v1 frame family (20-byte frames,
// 0x5A start / 0xFF end, same GATT UUIDs) but differs on the wire in
// verified ways. Authority: ntorq_constants.dart, ntorq_telemetry.dart,
// ntorq_crypto.dart, ntorq_ble_session.dart, ntorq_definition.dart
// (all dex-verified against TVS Connect v8.12.4, 2026-09-26).
//
// Verified differences encoded in this profile:
//   - 0x10 byte 6 fuel: LOW NIBBLE, 0-15 gauge steps (ntorq_telemetry.dart
//     line ~150: fuelLevel: frame[6] & 0x0F; class doc: CONFIRMED).
//   - Outbound frames XOR-masked with 0xEB: bytes 0-1 untouched,
//     bytes 2..n-2 XORed, trailing byte forced 0xFF
//     (ntorq_crypto.dart ntorqMaskFrame, lines 40-50; applied in
//     ntorq_ble_session.dart writeRaw).
//   - Write-with-response (ntorq_constants.dart writeWithResponse = true).
//   - No keep-alive ping loop (ntorq_ble_session.dart header comment).
//   - No auth-challenge handling (PROTOCOL.md section 9).
//   - Extra inbound IDs: 0x37 calibration response, 0x29 WiFi password
//     frame, 0x54 doc-transfer ACK (ntorq_constants.dart NtorqId).
//   - Music 0x6B command map 0-6 is the Ntorq-wired map
//     (ntorq_music.dart NtorqMusicCommand; ntorq_definition.dart).
//   - No find-me frame (ntorq_definition.dart capabilities: findMe false),
//     no silence-gap gesture engine (gestures false).
//   - Battery voltage: 0x18 byte 11 x 0.1, same as Jupiter
//     (ntorq_telemetry.dart batteryVoltageRaw: frame[11], x0.1 CONFIRMED;
//     matches the dex dossier). NOTE: this contradicts sim docs
//     PROTOCOL.md section 9's "0x11 byte 6 x0.1" claim; the Dart source
//     and the dex dossier both read 0x18 byte 11, so the Dart source wins.
const ntorq = {
  id: 'ntorq',
  label: 'TVS Ntorq 125 (SmartXonnect U_716)',
  encodeFuelByte(level01) {
    // Low nibble only, like the 125. Upper nibble reserved by the cluster;
    // zeroed on encode (stock only reads the low nibble).
    return Math.round(clamp01(level01) * FUEL_STEPS) & 0x0f;
  },
  decodeFuelByte(byte) {
    return (byte & 0x0f) / FUEL_STEPS;
  },
  serviceUuid: SERVICE_UUID,
  writeUuid: WRITE_UUID,
  notifyUuid: NOTIFY_UUID,
  // Telemetry cadence on Ntorq is UNVERIFIED (no cadence in the dex
  // dossier). Falls back to the 110 20 ms cadence.
  frameCadenceMs: { [0x10]: 20, [0x11]: 20, [0x18]: 20, [0x19]: 20 },
  notes: [
    'Fuel byte: LOW NIBBLE 0-15 gauge steps, CONFIRMED (ntorq_telemetry.dart fuelLevel: frame[6] & 0x0F; NtorqSpeedOMeter1 dex annotation).',
    'Outbound frames XOR-masked with 0xEB: bytes 0-1 untouched, bytes 2..n-2 XORed, last byte forced 0xFF (ntorq_crypto.dart ntorqMaskFrame; ntorq_ble_session.dart writeRaw). This is obfuscation, not security.',
    'Write-with-response, no auto-connect (ntorq_constants.dart NtorqBle).',
    'No keep-alive 0x4A ping loop on Ntorq (ntorq_ble_session.dart header comment; cyclic mobile-data layout UNVERIFIED).',
    'No auth-challenge handling on Ntorq (PROTOCOL.md section 9; standing safety rule).',
    'Extra inbound IDs: 0x37 calibration response, 0x29 WiFi password frame (counted as known, never decrypted), 0x54 doc-transfer ACK (ntorq_constants.dart NtorqId).',
    'Music 0x6B command map 0-6 wired on Ntorq (play/pause/toggle/next/prev/vol+/vol-, ntorq_music.dart).',
    'Ignition: 0x10 byte 12, 128 = ON, 64 = off (CONFIRMED, ntorq_constants.dart NtorqIgnition); call accept/reject values on that byte are UNVERIFIED (NtorqCallSwitch placeholders).',
    'Battery voltage: 0x18 byte 11 x 0.1, same as Jupiter (ntorq_telemetry.dart; dex dossier). PROTOCOL.md section 9 claims 0x11 byte 6; the Dart source and dossier both say 0x18 byte 11.',
    'No find-me frame and no silence-gap gesture engine on Ntorq (ntorq_definition.dart capabilities).',
    '0x10/0x11 multi-byte byte order (odo/RPM/DTE) is UNVERIFIED (little-endian is the Dart default, ntorq_telemetry.dart ntorqAssumeLittleEndian).',
    'UUIDs identical to the Jupiter family (ntorq_constants.dart NtorqBle).',
    'UNVERIFIED: inbound telemetry cadence (falls back to 20 ms).',
  ],
  extras: {
    outboundXorMask: 0xeb,
    writeWithResponse: true,
    keepalivePing: false,
    authChallengeExpected: false,
    modelVariant125Gate: false,
    inboundIds: [0x10, 0x11, 0x18, 0x19, 0x37, 0x29, 0x54, 0x6b],
    findMe: false,
    gestures: false,
    unverified: [
      'inbound telemetry cadence',
      '0x10 byte-12 call accept/reject switch values',
      'multi-byte field byte order (odo/RPM/DTE)',
      'cyclic mobile-data packet layout',
    ],
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROFILES = { jupiter110, jupiter125, ntorq };

export function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new Error(`unknown vehicle profile: ${id}`);
  return p;
}

export function listProfileIds() {
  return Object.keys(PROFILES);
}
