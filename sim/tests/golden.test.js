/**
 * golden.test.js - W12 verification: golden-vector tests for the Scoot
 * Scooter Simulator frame layer.
 *
 * PURPOSE: independently prove the sim's frames decode the way the real
 * Scoot Flutter app decodes them. Golden frames are hand-constructed byte
 * by byte from the Dart decode logic (authoritative source:
 * ~/workspace/projects/scoot/lib/vehicles/tvs_jupiter/, dex-verified
 * against TVS Connect v8.12.4). Expected values are computed by hand from
 * the documented byte layout, NOT by running the decoders, so the test
 * genuinely cross-checks the layout.
 *
 * STRUCTURE:
 *  Part A - "dart logic mirror": faithful JS reimplementations of the Dart
 *           decoders (jupiter_telemetry.dart, jupiter_checksum.dart, the
 *           0x6B dispatch in jupiter_ble_session.dart). These exist so the
 *           golden vectors are executable NOW, before W3's engine lands.
 *           They mirror the Dart code line for line; any Dart behavior
 *           change must be re-mirrored here.
 *  Part B - golden vectors: hand-built inbound frames -> asserted decode.
 *  Part C - engine cross-check: if sim/src/engine/frames.js exists, the
 *           same vectors run through the engine's builders/parsers and the
 *           results are compared against the mirror. Skipped (not failed)
 *           while the engine is absent.
 *
 * Runner: node:test, zero dependencies. `node --test tests/golden.test.js`
 * from the sim directory.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Part A: faithful JS mirrors of the Dart decoders.
// Source: jupiter_telemetry.dart, jupiter_checksum.dart,
//         jupiter_constants.dart, jupiter_ble_session.dart (0x6B dispatch).
// ---------------------------------------------------------------------------

const FRAME_SIZE = 20;
const INBOUND_START = 0x5A;   // JupiterFrame.inboundStartByte
const INBOUND_ALT = 0x9B;     // JupiterFrame.inboundAltStartByte
const OUTBOUND_START = 0x5B;  // JupiterFrame.startByte
const END_BYTE = 0xFF;        // JupiterFrame.endByte
const CHECKSUM_INDEX = 18;    // JupiterFrame.checksumIndex

// jupiterChecksum: 255 - (sum(bytes[0..17]) % 256)
function checksumMirror(first18Bytes) {
  let sum = 0;
  for (const b of first18Bytes) sum += b & 0xff;
  return 255 - (sum % 256);
}

// jupiterChecksumMatches: informational only, never an inbound gate.
function checksumMatchesMirror(frame) {
  if (frame.length !== FRAME_SIZE) return false;
  return frame[CHECKSUM_INDEX] === checksumMirror(frame.slice(0, 18));
}

// jupiterVerifyFrame, clusterToPhone: structural only (length + start +
// end byte). Never gated on the checksum (matches the Dart comment about
// the on-hardware "cksum BAD, frozen speed" incident).
function verifyFrameInboundMirror(frame) {
  if (frame.length !== FRAME_SIZE) return false;
  const startOk =
    frame[0] === INBOUND_START ||
    frame[0] === INBOUND_ALT ||
    frame[0] === OUTBOUND_START;
  if (!startOk) return false;
  if (frame[FRAME_SIZE - 1] !== END_BYTE) return false;
  return true;
}

// decodePrimary (0x10). jupiter125 selects the fuel-byte model gate.
function decodePrimaryMirror(frame, jupiter125 = false) {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[1] !== 0x10) return null;
  const raw24 = (frame[3] << 16) | (frame[4] << 8) | frame[5];
  const fuelRaw = frame[6];
  let fuelLevel, reserve;
  if (jupiter125) {
    fuelLevel = fuelRaw & 0x0f; // int2bytes low-nibble extraction
    reserve = false;
  } else {
    fuelLevel = fuelRaw;
    reserve = (fuelRaw & 0xf0) !== 0;
  }
  const tripRaw24 = (frame[14] << 16) | (frame[15] << 8) | frame[16];
  return {
    odometerRaw24: raw24,
    odometerKm: raw24 / 10.0,
    speedKmh: frame[2],
    fuelByteRaw: fuelRaw,
    fuelLevel,
    fuelBars: fuelLevel,
    reserve,
    ecoPowerByte: frame[8],
    powerMode: frame[8] === 1,
    trafficScreenUp: (frame[8] >> 4) === 7,
    averageSpeedKmh: frame[7],
    topSpeedKmh: frame[9],
    throttlePosition: frame[10],
    backlightByte: frame[11],
    ignitionSwitchByte: frame[12],
    ignitionOn: frame[12] === 128,
    vehicleOff: frame[12] === 64,
    callSwitchByte: frame[12],
    zeroToSixtyRaw: frame[13],
    tripMeterRaw24: tripRaw24,
    tripMeterKm: tripRaw24 / 10.0,
    engineRpm: (frame[17] << 8) | frame[18],
  };
}

// decodeService (0x11).
function decodeServiceMirror(frame) {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[1] !== 0x11) return null;
  const vehicleDiagnostics = frame[10];
  return {
    fuelSensorFailure: frame[2],
    vehicleState1: frame[3],
    serviceReminder: frame[4] !== 0,
    issByte: frame[6],
    speedoSwVersion: frame[7],
    milBlinkCode: frame[8],
    vehicleModelRaw: frame[9],
    vehicleDiagnostics,
    milOn: (vehicleDiagnostics & 0x04) !== 0,
    isgBlinkCode: frame[11],
    turnIndicatorStatus: frame[12],
    connectorStatus: frame[13],
    clusterTheme: frame[14],
    captureScreenshot: frame[17],
  };
}

// decodeEngine (0x18). Battery: raw * 0.1 rounded to 2 decimals
// (mirrors String.format("%.2f") round-trip; raw 121 -> 12.10 V).
function decodeEngineMirror(frame) {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[1] !== 0x18) return null;
  const be16 = (hi, lo) => (frame[hi] << 8) | frame[lo];
  const batteryVoltageRaw = frame[11];
  return {
    engineLoad: frame[2],
    accumulatedFuelInjectionTime: be16(3, 4),
    manifoldAirPressure: frame[5],
    barometricPressureU714: frame[6],
    intakeAirTemperature: frame[7],
    engineTemperature: frame[8],
    barometricPressure: be16(9, 10),
    batteryVoltageRaw,
    batteryVoltage: parseFloat((batteryVoltageRaw * 0.1).toFixed(2)),
    engineRunningTime: be16(12, 13),
    distanceTraveled: be16(14, 15),
    fuelInjectionVolume: be16(16, 17),
  };
}

// decodeEconomy (0x19). DTE is BE UInt16 at bytes 11-12.
function decodeEconomyMirror(frame) {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[1] !== 0x19) return null;
  return {
    economyKmpl: frame[8],
    dteKm: (frame[11] << 8) | frame[12],
    issDurationRaw24: (frame[2] << 16) | (frame[3] << 8) | frame[4],
    otaStatus: frame[5],
    instantEconomyKmpl: frame[9],
    issCountRaw24: (frame[15] << 16) | (frame[16] << 8) | frame[17],
  };
}

// decodeMusicCommand (0x6B): byte 2 -> command, 0..6; else null.
const MUSIC_COMMANDS = [
  'play',       // 0
  'pause',      // 1
  'toggle',     // 2
  'next',       // 3
  'previous',   // 4
  'volumeUp',   // 5
  'volumeDown', // 6
];

function decodeMusicCommandMirror(frame) {
  if (frame.length !== FRAME_SIZE) return null;
  if (frame[1] !== 0x6b) return null;
  const cmd = frame[2];
  return cmd >= 0 && cmd <= 6 ? MUSIC_COMMANDS[cmd] : null;
}

// mediaKeyKindFor: dex-verified 0x6B command -> phone media key.
function mediaKeyKindForMirror(cmd) {
  switch (cmd) {
    case 'play': return 'play';
    case 'pause': return 'pause';
    case 'toggle': return 'playPause';
    case 'next': return 'next';
    case 'previous': return 'previous';
    case 'volumeUp': return 'volumeUp';
    case 'volumeDown': return 'volumeDown';
    default: throw new Error('unknown music command: ' + cmd);
  }
}

// Legacy raw accessor: decodeMusicFrameCommand returns cmd index or null.
function decodeMusicFrameCommandMirror(frame) {
  const cmd = decodeMusicCommandMirror(frame);
  return cmd === null ? null : MUSIC_COMMANDS.indexOf(cmd);
}

// ---------------------------------------------------------------------------
// Part B: golden vectors. Frames hand-constructed byte by byte from the
// documented layout; expected values computed by hand, not by the decoders.
// ---------------------------------------------------------------------------

/**
 * Build a 20-byte inbound frame: 0x5A, id, 16 payload bytes (bytes 2..17),
 * byte 18 (checksum by default, or `byte18` override), 0xFF.
 */
function inboundFrame(id, payload2to17, byte18 = null) {
  if (payload2to17.length !== 16) {
    throw new Error('payload must be exactly 16 bytes (bytes 2..17)');
  }
  const f = new Array(FRAME_SIZE).fill(0);
  f[0] = INBOUND_START;
  f[1] = id;
  for (let i = 0; i < 16; i++) f[2 + i] = payload2to17[i] & 0xff;
  f[CHECKSUM_INDEX] =
    byte18 === null ? checksumMirror(f.slice(0, 18)) : byte18 & 0xff;
  f[FRAME_SIZE - 1] = END_BYTE;
  return f;
}

// Golden 0x10 frame: speed 42 kph, odo bytes 00 30 39 (raw24 = 12345 ->
// 1234.5 km), fuel byte 0x35, avg 38, eco/power 1 (power), top 89,
// throttle 64, backlight 0x01, ignition byte 12 = 128 (IG on), t60 raw 0,
// trip bytes 00 03 E8 (raw24 = 1000 -> 100.0 km), rpm bytes 0E 10
// (3600 rpm). Byte 18 holds the RPM low byte (0x10); the checksum byte is
// informational and NOT asserted here (real clusters do not reliably
// compute it).
const GOLDEN_0x10 = inboundFrame(
  0x10,
  [
    42, // [2]  speed
    0x00, 0x30, 0x39, // [3..5] odo
    0x35, // [6]  fuel byte
    38, // [7]  avg speed
    1, // [8]  eco/power = power
    89, // [9]  top speed
    64, // [10] throttle
    0x01, // [11] backlight
    128, // [12] ignition = IG on
    0x00, // [13] 0-60 raw
    0x00, 0x03, 0xe8, // [14..16] trip
    0x0e, // [17] rpm hi (byte 18 = rpm lo, passed as override below)
  ],
  0x10 // byte18 override: RPM low byte, deliberately not the checksum
);

// Golden 0x18 frame: battery raw 126 -> 12.60 V, engine temp 87 C,
// engine load 45, fuel-inj time BE 01 2C (300), MAP 78, baro U714 101,
// intake 35, baro BE 03 E8 (1000), run time BE 00 3C (60),
// distance BE 00 64 (100), fuel-inj volume BE 02 58 (600).
const GOLDEN_0x18 = inboundFrame(0x18, [
  45, // [2]  engine load
  0x01, 0x2c, // [3..4] fuel injection time
  78, // [5]  MAP
  101, // [6]  baro U714
  35, // [7]  intake air temp
  87, // [8]  engine temp
  0x03, 0xe8, // [9..10] barometric pressure
  126, // [11] battery raw (12.6 V)
  0x00, 0x3c, // [12..13] engine running time
  0x00, 0x64, // [14..15] distance traveled
  0x02, 0x58, // [16..17] fuel injection volume
]);

// Golden 0x19 frame: instant FE 45 km/L, avg FE 52 km/L, DTE BE 00 B4
// (180 km), ISS duration 24-bit 00 00 1E (30), OTA 1, ISS count 24-bit
// 00 00 07 (7).
const GOLDEN_0x19 = inboundFrame(0x19, [
  0x00, 0x00, 0x1e, // [2..4] ISS duration
  1, // [5]  OTA status
  0x00, 0x00, // [6..7] unused
  52, // [8]  average FE
  45, // [9]  instant FE
  0x00, // [10] unused
  0x00, 0xb4, // [11..12] DTE
  0x00, 0x00, // [13..14] unused
  0x00, 0x00, 0x07, // [15..17] ISS count
]);

// Golden 0x11 frame, DTC SET: service reminder 1, MIL blink 3,
// vehicle model raw 2, diagnostics 0x04 (bit 2 -> MIL on), ISS byte 0x11,
// sw version 5, vehicle state 2, ISG blink 1, cluster theme 2.
const GOLDEN_0x11_DTC = inboundFrame(0x11, [
  0x00, // [2] fuel sensor failure
  0x02, // [3] vehicle state 1
  0x01, // [4] service reminder = due
  0x00, // [5] unused
  0x11, // [6] ISS byte
  0x05, // [7] speedo SW version
  0x03, // [8] MIL blink code
  0x02, // [9] vehicle model raw
  0x04, // [10] vehicle diagnostics (bit 2 = MIL on)
  0x01, // [11] ISG blink code
  0x00, // [12] turn indicator
  0x00, // [13] connector status
  0x02, // [14] cluster theme
  0x00, // [15] unused
  0x00, 0x00, // [16..17] unused / screenshot
]);

// Golden 0x11 frame, DTC ABSENT: diagnostics 0x00 (MIL off), blink 0,
// service reminder 0.
const GOLDEN_0x11_CLEAN = inboundFrame(0x11, [
  0x00, 0x02, 0x00, 0x00, 0x11, 0x05, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00,
]);

// Golden 0x6B frames: command at byte 2.
const GOLDEN_0x6B_NEXT = inboundFrame(0x6b, [
  3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const GOLDEN_0x6B_PLAY = inboundFrame(0x6b, [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const GOLDEN_0x6B_VOLUP = inboundFrame(0x6b, [
  5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const GOLDEN_0x6B_UNKNOWN = inboundFrame(0x6b, [
  7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

describe('golden vectors: 0x10 primary telemetry', () => {
  test('speed, odometer, ignition, RPM decode per documented layout', () => {
    const p = decodePrimaryMirror(GOLDEN_0x10);
    assert.ok(p, 'decoder must accept the golden 0x10 frame');
    assert.equal(p.speedKmh, 42, 'byte 2 -> speed');
    assert.equal(p.odometerRaw24, 0x003039, 'bytes 3..5 BE raw24');
    assert.equal(p.odometerRaw24, 12345);
    assert.equal(p.odometerKm, 1234.5, 'odo km = raw24 / 10');
    assert.equal(p.engineRpm, (0x0e << 8) | 0x10, 'bytes 17..18 BE rpm');
    assert.equal(p.engineRpm, 3600);
    assert.equal(p.ignitionSwitchByte, 128, 'byte 12 = 128');
    assert.equal(p.ignitionOn, true, '128 = IG on');
    assert.equal(p.vehicleOff, false, 'not 64');
    assert.equal(p.callSwitchByte, 128, 'byte 12 doubles as call switch');
    assert.equal(p.averageSpeedKmh, 38, 'byte 7');
    assert.equal(p.topSpeedKmh, 89, 'byte 9');
    assert.equal(p.throttlePosition, 64, 'byte 10');
    assert.equal(p.ecoPowerByte, 1, 'byte 8 = power');
    assert.equal(p.powerMode, true);
    assert.equal(p.backlightByte, 0x01, 'byte 11');
    assert.equal(p.zeroToSixtyRaw, 0, 'byte 13 surfaced raw');
    assert.equal(p.tripMeterRaw24, 1000, 'bytes 14..16 BE raw24');
    assert.equal(p.tripMeterKm, 100.0, 'trip km = raw24 / 10');
  });

  test('wrong ID or wrong length rejected', () => {
    const as011 = GOLDEN_0x10.slice();
    as011[1] = 0x11;
    assert.equal(decodePrimaryMirror(as011), null, 'ID 0x11 rejected');
    const short = GOLDEN_0x10.slice(0, 19);
    assert.equal(decodePrimaryMirror(short), null, '19-byte frame rejected');
  });
});

describe('golden vectors: 0x10 fuel byte, 110 vs 125 rule', () => {
  test('110 passes raw byte through; upper nibble nonzero -> reserve', () => {
    const p = decodePrimaryMirror(GOLDEN_0x10, false);
    assert.equal(p.fuelByteRaw, 0x35);
    assert.equal(p.fuelLevel, 0x35, '110: raw passthrough');
    assert.equal(p.fuelLevel, 53);
    assert.equal(p.fuelBars, 53, '110: bars = fuelLevel (Scoot interp)');
    assert.equal(p.reserve, true, '110: upper nibble 0x3 nonzero');
  });

  test('125 extracts low nibble; reserve always false', () => {
    const p = decodePrimaryMirror(GOLDEN_0x10, true);
    assert.equal(p.fuelLevel, 0x35 & 0x0f, '125: int2bytes low nibble');
    assert.equal(p.fuelLevel, 5);
    assert.equal(p.reserve, false, '125: no upper nibble survives');
  });

  test('125 low-nibble fixtures from dex notes: 0x3C -> 12, 0x80 -> 0', () => {
    const mk = (fuel) => {
      const f = GOLDEN_0x10.slice();
      f[6] = fuel;
      return decodePrimaryMirror(f, true);
    };
    assert.equal(mk(0x3c).fuelLevel, 12);
    assert.equal(mk(0x80).fuelLevel, 0);
    assert.equal(mk(0x3c).reserve, false);
  });
});

describe('golden vectors: 0x18 engine telemetry', () => {
  test('battery voltage, engine temp, and multi-byte BE fields', () => {
    const e = decodeEngineMirror(GOLDEN_0x18);
    assert.ok(e, 'decoder must accept the golden 0x18 frame');
    assert.equal(e.batteryVoltageRaw, 126, 'byte 11 raw');
    assert.equal(e.batteryVoltage, 12.6, 'volts = raw * 0.1, 2 decimals');
    assert.equal(e.engineTemperature, 87, 'byte 8');
    assert.equal(e.engineLoad, 45, 'byte 2');
    assert.equal(e.accumulatedFuelInjectionTime, 0x012c, 'bytes 3..4 BE');
    assert.equal(e.accumulatedFuelInjectionTime, 300);
    assert.equal(e.manifoldAirPressure, 78, 'byte 5');
    assert.equal(e.barometricPressureU714, 101, 'byte 6');
    assert.equal(e.intakeAirTemperature, 35, 'byte 7');
    assert.equal(e.barometricPressure, 1000, 'bytes 9..10 BE');
    assert.equal(e.engineRunningTime, 60, 'bytes 12..13 BE');
    assert.equal(e.distanceTraveled, 100, 'bytes 14..15 BE');
    assert.equal(e.fuelInjectionVolume, 600, 'bytes 16..17 BE');
  });

  test('battery rounding parity: raw 121 -> 12.10', () => {
    const f = GOLDEN_0x18.slice();
    f[11] = 121;
    const e = decodeEngineMirror(f);
    assert.equal(e.batteryVoltage, 12.1);
    assert.equal(e.batteryVoltage.toFixed(2), '12.10');
  });

  test('wrong ID rejected', () => {
    const f = GOLDEN_0x18.slice();
    f[1] = 0x19;
    assert.equal(decodeEngineMirror(f), null);
  });
});

describe('golden vectors: 0x19 economy', () => {
  test('instant FE, DTE, and 24-bit raw fields', () => {
    const e = decodeEconomyMirror(GOLDEN_0x19);
    assert.ok(e, 'decoder must accept the golden 0x19 frame');
    assert.equal(e.instantEconomyKmpl, 45, 'byte 9 instant FE');
    assert.equal(e.economyKmpl, 52, 'byte 8 average FE');
    assert.equal(e.dteKm, 0x00b4, 'bytes 11..12 BE DTE');
    assert.equal(e.dteKm, 180);
    assert.equal(e.issDurationRaw24, 30, 'bytes 2..4 raw24');
    assert.equal(e.otaStatus, 1, 'byte 5');
    assert.equal(e.issCountRaw24, 7, 'bytes 15..17 raw24');
  });
});

describe('golden vectors: 0x11 service / DTC', () => {
  test('DTC present: MIL on, blink code, service reminder', () => {
    const s = decodeServiceMirror(GOLDEN_0x11_DTC);
    assert.ok(s, 'decoder must accept the golden 0x11 frame');
    assert.equal(s.milOn, true, 'byte 10 bit 2 set -> MIL on');
    assert.equal(s.milBlinkCode, 3, 'byte 8');
    assert.equal(s.serviceReminder, true, 'byte 4 nonzero -> due');
    assert.equal(s.vehicleModelRaw, 2, 'byte 9 surfaced raw');
    assert.equal(s.isgBlinkCode, 1, 'byte 11');
    assert.equal(s.clusterTheme, 2, 'byte 14');
    assert.equal(s.issByte, 0x11, 'byte 6');
    assert.equal(s.vehicleState1, 2, 'byte 3');
    assert.equal(s.fuelSensorFailure, 0, 'byte 2');
    assert.equal(s.vehicleDiagnostics, 0x04, 'byte 10 raw');
  });

  test('DTC absent: MIL off, no blink, no service reminder', () => {
    const s = decodeServiceMirror(GOLDEN_0x11_CLEAN);
    assert.ok(s);
    assert.equal(s.milOn, false, 'byte 10 = 0 -> MIL off');
    assert.equal(s.milBlinkCode, 0);
    assert.equal(s.serviceReminder, false, 'byte 4 = 0');
    assert.equal(s.vehicleModelRaw, 2, 'model byte still surfaced raw');
  });
});

describe('golden vectors: 0x6B music button passthrough', () => {
  test('dex-verified command map 0..6', () => {
    for (let cmd = 0; cmd <= 6; cmd++) {
      const f = GOLDEN_0x6B_PLAY.slice();
      f[2] = cmd;
      assert.equal(
        decodeMusicCommandMirror(f),
        MUSIC_COMMANDS[cmd],
        'byte 2 = ' + cmd
      );
      assert.equal(
        decodeMusicFrameCommandMirror(f),
        cmd,
        'legacy raw accessor returns index'
      );
    }
  });

  test('command 3 = next dispatches media key next', () => {
    const cmd = decodeMusicCommandMirror(GOLDEN_0x6B_NEXT);
    assert.equal(cmd, 'next');
    assert.equal(mediaKeyKindForMirror(cmd), 'next');
  });

  test('command 0 = play, command 5 = volumeUp', () => {
    assert.equal(mediaKeyKindForMirror('play'), 'play');
    assert.equal(mediaKeyKindForMirror('volumeUp'), 'volumeUp');
    assert.equal(mediaKeyKindForMirror('toggle'), 'playPause');
  });

  test('out-of-range command byte -> null (no dispatch)', () => {
    assert.equal(decodeMusicCommandMirror(GOLDEN_0x6B_UNKNOWN), null);
    assert.equal(decodeMusicFrameCommandMirror(GOLDEN_0x6B_UNKNOWN), null);
  });
});

describe('golden vectors: checksum', () => {
  test('formula fixtures: 255 - (sum(bytes[0..17]) % 256)', () => {
    const zeros = new Array(18).fill(0);
    assert.equal(checksumMirror(zeros), 255, 'sum 0 -> 255');
    const f = new Array(18).fill(0);
    f[0] = 0x5b;
    f[1] = 0x10;
    // sum = 0x5B + 0x10 = 91 + 16 = 107; 255 - 107 = 148
    assert.equal(checksumMirror(f), 148);
    const ff = new Array(18).fill(0xff);
    // sum = 18 * 255 = 4590; 4590 % 256 = 238; 255 - 238 = 17
    assert.equal(checksumMirror(ff), 17);
  });

  test('checksumMatches: positive on well-formed frame, negative on flip', () => {
    assert.equal(
      checksumMatchesMirror(GOLDEN_0x18),
      true,
      'builder-computed byte 18 matches'
    );
    const tampered = GOLDEN_0x18.slice();
    tampered[CHECKSUM_INDEX] ^= 0x01;
    assert.equal(
      checksumMatchesMirror(tampered),
      false,
      'single-bit flip detected'
    );
  });

  test('inbound decode is NOT gated on the checksum', () => {
    // GOLDEN_0x10 carries the RPM low byte at byte 18, so its checksum
    // byte deliberately does not match the formula (realistic cluster).
    assert.equal(
      checksumMatchesMirror(GOLDEN_0x10),
      false,
      'golden 0x10 byte 18 is RPM lo, not a checksum'
    );
    const p = decodePrimaryMirror(GOLDEN_0x10);
    assert.ok(p, 'decode still succeeds: inbound is structural-only');
    assert.equal(p.speedKmh, 42);
    assert.equal(
      verifyFrameInboundMirror(GOLDEN_0x10),
      true,
      'verify passes despite checksum mismatch'
    );
  });
});

describe('golden vectors: frame anatomy and inbound verification', () => {
  test('every golden frame is 20 bytes, starts 0x5A, ends 0xFF', () => {
    for (const [name, f] of [
      ['0x10', GOLDEN_0x10],
      ['0x18', GOLDEN_0x18],
      ['0x19', GOLDEN_0x19],
      ['0x11', GOLDEN_0x11_DTC],
      ['0x6B', GOLDEN_0x6B_NEXT],
    ]) {
      assert.equal(f.length, 20, name + ': size');
      assert.equal(f[0], 0x5a, name + ': start byte');
      assert.equal(f[19], 0xff, name + ': end byte');
    }
  });

  test('inbound start-byte superset: 0x5A, 0x9B, 0x5B accepted', () => {
    assert.equal(verifyFrameInboundMirror(GOLDEN_0x10), true, '0x5A');
    const alt = GOLDEN_0x10.slice();
    alt[0] = 0x9b;
    assert.equal(verifyFrameInboundMirror(alt), true, '0x9B alt');
    const echo = GOLDEN_0x10.slice();
    echo[0] = 0x5b;
    assert.equal(verifyFrameInboundMirror(echo), true, '0x5B superset');
  });

  test('structural rejects: bad start, bad end, wrong length', () => {
    const badStart = GOLDEN_0x10.slice();
    badStart[0] = 0x00;
    assert.equal(verifyFrameInboundMirror(badStart), false, 'bad start');
    const badEnd = GOLDEN_0x10.slice();
    badEnd[19] = 0x00;
    assert.equal(verifyFrameInboundMirror(badEnd), false, 'bad end');
    assert.equal(
      verifyFrameInboundMirror(GOLDEN_0x10.slice(0, 19)),
      false,
      'short frame'
    );
    assert.equal(
      verifyFrameInboundMirror([...GOLDEN_0x10, 0x00]),
      false,
      'long frame'
    );
  });
});

// ---------------------------------------------------------------------------
// Part C: engine cross-check (W3). The engine (sim/src/engine/frames.js)
// is the sim side: it BUILDS inbound frames (the app decodes them) and
// DECODES outbound frames (the app builds them). So the verification runs
// both directions against the Dart-logic mirrors:
//   engine builder -> Dart mirror decode -> golden expectations, and
//   engine jupiterChecksum -> mirror formula fixtures.
// Skipped (not failed) while src/engine/frames.js is absent.
// ---------------------------------------------------------------------------

const ENGINE_FRAMES_URL = new URL('../src/engine/frames.js', import.meta.url);
const enginePresent = existsSync(ENGINE_FRAMES_URL);

test(
  'Part C: engine cross-check against golden vectors',
  {
    skip: !enginePresent
      ? 'PENDING ENGINE: sim/src/engine/frames.js not present yet'
      : false,
  },
  async (t) => {
    const engine = await import(ENGINE_FRAMES_URL.href);

    const need = [
      'buildPrimary',
      'buildService',
      'buildEngine',
      'buildEconomy',
      'buildMusicButton',
      'jupiterChecksum',
    ];
    const missing = need.filter((n) => typeof engine[n] !== 'function');

    await t.test('engine exports the expected builder surface', () => {
      assert.deepEqual(missing, [], 'missing exports: ' + missing.join(', '));
    });
    if (missing.length > 0) return;

    await t.test('engine jupiterChecksum matches the Dart formula', () => {
      const zeros = new Array(18).fill(0);
      assert.equal(engine.jupiterChecksum(zeros), 255, 'sum 0 -> 255');
      const f = new Array(18).fill(0);
      f[0] = 0x5b;
      f[1] = 0x10;
      assert.equal(engine.jupiterChecksum(f), 148, 'sum 107 -> 148');
      assert.equal(
        engine.jupiterChecksum(GOLDEN_0x18.slice(0, 18)),
        checksumMirror(GOLDEN_0x18.slice(0, 18)),
        'agrees with mirror on the golden 0x18 prefix'
      );
    });

    await t.test('built frames have valid anatomy', () => {
      for (const [name, frame] of [
        ['0x10', engine.buildPrimary({})],
        ['0x11', engine.buildService({})],
        ['0x18', engine.buildEngine({})],
        ['0x19', engine.buildEconomy({})],
        ['0x6B', engine.buildMusicButton(3)],
      ]) {
        assert.equal(frame.length, 20, name + ': 20 bytes');
        assert.equal(frame[0], 0x5a, name + ': cluster start byte');
        assert.equal(frame[19], 0xff, name + ': end byte');
      }
    });

    await t.test('buildPrimary -> app decode: golden 0x10 values', () => {
      const frame = engine.buildPrimary({
        speedKph: 42,
        odoKm: 1234.5,
        fuelByte: 0x35,
        avgSpeedKph: 38,
        ecoPowerByte: 1,
        topSpeedKph: 89,
        throttlePct: 64,
        backlightByte: 0x01,
        ignitionOn: true,
        tripKm: 100,
        rpm: 3600,
      });
      // Byte-level layout matches the golden vector exactly.
      for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) {
        assert.equal(
          frame[i],
          GOLDEN_0x10[i],
          'byte ' + i + ' matches golden 0x10'
        );
      }
      const p = decodePrimaryMirror(Array.from(frame), false);
      assert.ok(p, 'app decode accepts the engine-built frame');
      assert.equal(p.speedKmh, 42);
      assert.equal(p.odometerRaw24, 12345);
      assert.equal(p.odometerKm, 1234.5);
      assert.equal(p.fuelLevel, 53, '110 passthrough');
      assert.equal(p.reserve, true);
      assert.equal(p.ignitionOn, true);
      assert.equal(p.engineRpm, 3600, 'RPM across bytes 17-18, no checksum');
      assert.equal(p.tripMeterKm, 100.0);
      assert.equal(p.powerMode, true);
    });

    await t.test('buildService -> app decode: DTC set and clear', () => {
      const dtc = engine.buildService({
        dtcCount: 3,
        serviceReminder: true,
        vehicleModelRaw: 2,
        issByte: 0x11,
        speedoSwVersion: 5,
        vehicleState1: 2,
        isgBlinkCode: 1,
        clusterTheme: 2,
      });
      assert.equal(dtc[8], 3, 'byte 8 = MIL blink code');
      assert.equal(dtc[10], 0x04, 'byte 10 bit 2 = MIL on');
      const s = decodeServiceMirror(Array.from(dtc));
      assert.ok(s);
      assert.equal(s.milOn, true);
      assert.equal(s.milBlinkCode, 3);
      assert.equal(s.serviceReminder, true);
      assert.equal(s.vehicleModelRaw, 2);

      const clean = engine.buildService({});
      const c = decodeServiceMirror(Array.from(clean));
      assert.equal(c.milOn, false, 'no DTC -> MIL off');
      assert.equal(c.serviceReminder, false);
    });

    await t.test('buildEngine -> app decode: battery and temps', () => {
      const frame = engine.buildEngine({
        batteryV: 12.6,
        engineTempC: 87,
        engineLoadPct: 45,
        accumFuelInjectionMs: 300,
        mapKpa: 78,
        baroU714: 101,
        intakeTempC: 35,
        baroHpa: 1000,
        runTimeS: 60,
        distanceKm: 10,
        fuelInjectionMl: 600,
      });
      assert.equal(frame[11], 126, 'byte 11 = batteryV * 10');
      const e = decodeEngineMirror(Array.from(frame));
      assert.ok(e);
      assert.equal(e.batteryVoltage, 12.6, 'raw x 0.1 V');
      assert.equal(e.engineTemperature, 87);
      assert.equal(e.engineLoad, 45);
      assert.equal(e.accumulatedFuelInjectionTime, 300);
      assert.equal(e.barometricPressure, 1000);
      assert.equal(e.engineRunningTime, 60);
    });

    await t.test('buildEconomy -> app decode: FE and DTE', () => {
      const frame = engine.buildEconomy({
        instantKmpl: 45,
        avgKmpl: 52,
        dteKm: 180,
        issDurationRaw: 30,
        otaStatus: 1,
        issCountRaw: 7,
      });
      assert.equal(frame[9], 45, 'byte 9 = instant FE');
      assert.equal((frame[11] << 8) | frame[12], 180, 'bytes 11-12 BE DTE');
      const e = decodeEconomyMirror(Array.from(frame));
      assert.ok(e);
      assert.equal(e.instantEconomyKmpl, 45);
      assert.equal(e.economyKmpl, 52);
      assert.equal(e.dteKm, 180);
      assert.equal(e.issCountRaw24, 7);
    });

    await t.test('buildMusicButton -> app decode: command passthrough', () => {
      for (let cmd = 0; cmd <= 6; cmd++) {
        const frame = engine.buildMusicButton(cmd);
        assert.equal(frame[1], 0x6b, 'ID byte');
        assert.equal(frame[2], cmd, 'command at byte 2');
        assert.equal(
          decodeMusicCommandMirror(Array.from(frame)),
          MUSIC_COMMANDS[cmd],
          'app decodes command ' + cmd
        );
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Part D: reconciliation pin (W9 vs W3, 2026-09-30).
//
// Dispute: W9's telemetry-lab accepts a 0x5A lead byte on outbound
// nav-control frames; W3's decodeOutbound flags any 0x5A lead byte as
// bad-start (except 0xF1).
//
// Dart verdict (authoritative): the real app sends 0x5A at index 0 on TWO
// outbound frame types:
//   - nav-control: buildNavControlFrame, jupiter_navigation.dart:217-218:
//       packet[0] = JupiterId.navControl0 (0x5A, jupiter_constants.dart:63),
//       packet[1] = JupiterId.navControl1 (0x4E)
//   - vehicle control (brightness): buildVehicleControlFrame,
//       jupiter_settings.dart:39-40: f[0] = 0x5A, f[1] = 0xF1
// Contrast (lead 0x5B): buildNavTextFrame (jupiter_navigation.dart:182:
// packet[0] = JupiterFrame.startByte) and buildCalibrationFrame
// (jupiter_settings.dart:57: f[0] = 0x5B).
//
// VERDICT: W9 is right. W3's decodeOutbound must accept a 0x5A lead byte
// for the nav-control frame (ID 0x4E at byte 1) in addition to the 0xF1
// vehicle-control frame. The 'decodeOutbound accepts 0x5A-lead
// nav-control' test below FAILS against the current engine and goes green
// once the fix is applied. Fix (for the integrator, do not apply here):
//   const start5aOk = start === 0x5a &&
//     (id === ID_VEHICLE_CONTROL || id === ID_NAV_CONTROL);
//   if (start !== START_PHONE && !start5aOk) {
//     return { known: false, kind: 'bad-start' };
//   }
// ---------------------------------------------------------------------------

// Mirror of buildNavControlFrame (jupiter_navigation.dart:208-239).
function dartBuildNavControlMirror(o) {
  const p = new Array(20).fill(0);
  p[0] = 0x5a; // JupiterId.navControl0, NOT JupiterFrame.startByte
  p[1] = 0x4e; // JupiterId.navControl1
  const dist = Math.min(65535, Math.max(0, o.distanceM));
  p[2] = (dist >> 8) & 0xff;
  p[3] = dist & 0xff;
  const eta = Math.min(0xffff, Math.max(0, o.etaMinutes));
  p[4] = (eta >> 8) & 0xff;
  p[5] = eta & 0xff;
  const rem = Math.min(0xffffff, Math.max(0, o.remainingTripM));
  p[6] = (rem >> 16) & 0xff;
  p[7] = (rem >> 8) & 0xff;
  p[8] = rem & 0xff;
  p[9] = o.pictogram & 0xff;
  p[10] = Math.min(2, Math.max(1, o.rowCount ?? 1));
  p[11] = (o.navStatus ?? 0x01) & 0xff;
  p[19] = 0xff;
  return p;
}

// Mirror of buildVehicleControlFrame (jupiter_settings.dart:35-54).
// brightnessWireByte: level 1 -> 1, levels 2-5 -> level * 2.
function dartBuildVehicleControlMirror(brightnessLevel, date) {
  const f = new Array(20).fill(0);
  f[0] = 0x5a;
  f[1] = 0xf1;
  const l = Math.min(5, Math.max(1, brightnessLevel));
  f[2] = l === 1 ? 1 : l * 2;
  f[3] = 9;
  f[5] = 2;
  f[9] = date.day;
  f[11] = date.month - 1;
  f[13] = date.year & 0xff;
  f[15] = 1;
  f[16] = 0x01;
  f[19] = 0xff;
  return f;
}

describe('reconciliation pin: 0x5A lead byte on outbound frames', () => {
  test('Dart builder mirror: nav-control leads with 0x5A, ID 0x4E at byte 1', () => {
    const p = dartBuildNavControlMirror({
      distanceM: 250,
      etaMinutes: 12,
      remainingTripM: 12345,
      pictogram: 2,
    });
    assert.equal(p[0], 0x5a, 'lead byte (jupiter_navigation.dart:217)');
    assert.equal(p[1], 0x4e, 'byte 1 (jupiter_navigation.dart:218)');
    assert.deepEqual(p.slice(2, 4), [0x00, 0xfa], 'distance BE 250');
    assert.deepEqual(p.slice(4, 6), [0x00, 0x0c], 'eta BE 12');
    assert.deepEqual(p.slice(6, 9), [0x00, 0x30, 0x39], 'remaining BE24 12345');
    assert.equal(p[9], 2, 'pictogram');
    assert.equal(p[10], 1, 'rowCount default 1');
    assert.equal(p[11], 0x01, 'navStatus default 0x01');
    assert.equal(p[19], 0xff);
  });

  test('Dart builder mirror: vehicle-control leads with 0x5A, ID 0xF1 at byte 1', () => {
    const f = dartBuildVehicleControlMirror(3, {
      day: 30,
      month: 9,
      year: 2026,
    });
    assert.equal(f[0], 0x5a, 'lead byte (jupiter_settings.dart:39)');
    assert.equal(f[1], 0xf1, 'byte 1 (jupiter_settings.dart:40)');
    assert.equal(f[2], 6, 'brightness wire byte: level 3 -> 6');
    assert.equal(f[9], 30, 'phone day');
    assert.equal(f[11], 8, 'phone month - 1');
    assert.equal(f[13], 2026 & 0xff, 'phone year & 0xFF');
    assert.equal(f[19], 0xff);
    const lvl1 = dartBuildVehicleControlMirror(1, { day: 1, month: 1, year: 2026 });
    assert.equal(lvl1[2], 1, 'brightness wire byte: level 1 -> 1');
  });

  test('decodeOutbound accepts 0x5A-lead nav-control (W9 right, W3 fix pending)', async (t) => {
    if (!enginePresent) {
      t.skip('engine not present');
      return;
    }
    const engine = await import(ENGINE_FRAMES_URL.href);
    const wire = Uint8Array.from(
      dartBuildNavControlMirror({
        distanceM: 250,
        etaMinutes: 12,
        remainingTripM: 12345,
        pictogram: 2,
      })
    );
    const r = engine.decodeOutbound(wire);
    assert.equal(
      r.kind,
      'nav-control',
      '0x5A-lead nav-control must not be bad-start; got ' + JSON.stringify(r)
    );
    assert.equal(r.known, true);
    assert.equal(r.distanceM, 250);
    assert.equal(r.etaMinutes, 12);
    assert.equal(r.remainingTripM, 12345);
    assert.equal(r.pictogram, 2);
    assert.equal(r.rowCount, 1);
    assert.equal(r.navStatus, 1);
  });

  test('decodeOutbound accepts 0x5A-lead vehicle-control', async (t) => {
    if (!enginePresent) {
      t.skip('engine not present');
      return;
    }
    const engine = await import(ENGINE_FRAMES_URL.href);
    const wire = Uint8Array.from(
      dartBuildVehicleControlMirror(3, { day: 30, month: 9, year: 2026 })
    );
    const r = engine.decodeOutbound(wire);
    assert.equal(r.known, true);
    assert.equal(r.kind, 'ignored');
    assert.equal(r.ignoredId, 'vehicle-control');
    assert.equal(r.brightnessWireByte, 6);
  });

  test('0x5A lead stays bad-start for ordinary frames (fix boundary)', async (t) => {
    if (!enginePresent) {
      t.skip('engine not present');
      return;
    }
    const engine = await import(ENGINE_FRAMES_URL.href);
    // A 0x4A keepalive with a 0x5A lead byte is genuinely malformed: the
    // real 0x4A builder uses JupiterFrame.startByte (0x5B).
    const bad = new Uint8Array(20).fill(0);
    bad[0] = 0x5a;
    bad[1] = 0x4a;
    bad[19] = 0xff;
    const r = engine.decodeOutbound(bad);
    assert.equal(r.kind, 'bad-start', '0x5A lead on 0x4A stays rejected');
    const zero = new Uint8Array(20).fill(0);
    zero[1] = 0x4e;
    zero[19] = 0xff;
    assert.equal(
      engine.decodeOutbound(zero).kind,
      'bad-start',
      '0x00 lead stays rejected'
    );
  });
});
