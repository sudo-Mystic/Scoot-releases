// 20-byte Jupiter v1 frame builders (cluster -> phone, inbound) and
// outbound decoders (phone -> cluster). Pure logic, zero dependencies,
// no DOM.
//
// Byte maps: sim/docs/PROTOCOL.md, extracted from Scoot's
// lib/vehicles/tvs_jupiter (dex-verified against TVS Connect v8.12.4).
// Anything not verified there is left 0 and marked UNVERIFIED.

export const FRAME_SIZE = 20;
export const START_CLUSTER = 0x5a; // cluster -> phone start byte (sim emits)
export const START_PHONE = 0x5b; // phone -> cluster start byte (app sends)
export const END_BYTE = 0xff;
export const CHECKSUM_INDEX = 18;

// Inbound frame IDs (cluster -> phone). The sim emits these.
export const ID_PRIMARY = 0x10;
export const ID_SERVICE = 0x11;
export const ID_ENGINE = 0x18;
export const ID_ECONOMY = 0x19;
export const ID_MUSIC = 0x6b;

// Outbound frame IDs (phone -> cluster). The sim decodes these.
export const ID_MOBILE_DATA = 0x4a;
export const ID_TEXT_ROW1 = 0x4c;
export const ID_TEXT_ROW2 = 0x63;
export const ID_REGISTRATION = 0x52;
export const ID_NAV_CONTROL = 0x4e;
export const ID_NAV_TEXT = 0x4f;
export const ID_CALLER = 0x43;
export const ID_PICTOGRAM = 0x50;
export const ID_MEDIA_TITLE = 0x61;
export const ID_MEDIA_ARTIST = 0x62;
export const ID_MEDIA_ALBUM = 0x65;
export const ID_USER_ID = 0x22;
export const ID_VEHICLE_CONTROL = 0xf1; // start byte is 0x5A on the wire
export const ID_CALIBRATION = 0x73;

// Music button commands at 0x6B byte 2
// (BluetoothUtil.getMusicCommandType, dex-verified).
export const MUSIC_COMMANDS = Object.freeze({
  play: 0,
  pause: 1,
  toggle: 2,
  next: 3,
  previous: 4,
  volumeUp: 5,
  volumeDown: 6,
});

// Caller-info sub IDs (TelephonyUtils.writeCallerInformationToCluster).
export const CALLER_SUB = Object.freeze({
  nationalNumber: 0x01,
  contactName: 0x02,
  countryCode: 0x03,
});

// ---------------------------------------------------------------------------
// Checksum: 255 - (sum(bytes[0..17]) % 256). Exact Dart reference is
// jupiterChecksum in lib/vehicles/tvs_jupiter/jupiter_checksum.dart.
// Applies to outbound (phone -> cluster) frames. Inbound frames are NOT
// gated on it: the real app never verifies inbound checksums.
// ---------------------------------------------------------------------------
export function jupiterChecksum(first18Bytes) {
  let sum = 0;
  for (let i = 0; i < 18; i++) {
    sum += first18Bytes[i] & 0xff;
  }
  return 255 - (sum % 256);
}

// Calibration frame (0x73) uses its own dex-verified formula:
// checksum = (256 - (sum(bytes[2..8]) % 256)) & 0xFF, stored at byte 9.
export function calibrationChecksum(frame) {
  let sum = 0;
  for (let i = 2; i <= 8; i++) {
    sum += frame[i] & 0xff;
  }
  return (256 - (sum % 256)) & 0xff;
}

function clampByte(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function newInboundFrame(id) {
  const f = new Uint8Array(FRAME_SIZE);
  f[0] = START_CLUSTER;
  f[1] = id;
  f[FRAME_SIZE - 1] = END_BYTE;
  return f;
}

function writeU16BE(f, offset, value) {
  const v = Math.max(0, Math.round(value)) & 0xffff;
  f[offset] = (v >> 8) & 0xff;
  f[offset + 1] = v & 0xff;
}

function writeU24BE(f, offset, value) {
  const v = Math.max(0, Math.round(value)) & 0xffffff;
  f[offset] = (v >> 16) & 0xff;
  f[offset + 1] = (v >> 8) & 0xff;
  f[offset + 2] = v & 0xff;
}

// ---------------------------------------------------------------------------
// Inbound builders. NOTE: inbound frames do NOT carry the phone-side
// checksum at byte 18 (the real cluster does not reliably compute it and
// the app never verifies it). Byte 18 is left as protocol data, which is
// why buildPrimary writes RPM across bytes 17-18.
// ---------------------------------------------------------------------------

// 0x10 primary telemetry. fuelByte comes from profile.encodeFuelByte
// (110 vs 125 differ per the dex-verified handleSpeedOMeter gate).
export function buildPrimary(o = {}) {
  const f = newInboundFrame(ID_PRIMARY);
  f[2] = clampByte(o.speedKph ?? 0); // PROVISIONAL speed mapping
  writeU24BE(f, 3, (o.odoKm ?? 0) * 10); // big-endian; /10 scale UNVERIFIED
  f[6] = clampByte(o.fuelByte ?? 0);
  f[7] = clampByte(o.avgSpeedKph ?? 0);
  f[8] = clampByte(o.ecoPowerByte ?? 0); // 0 = Economy, 1 = Power
  f[9] = clampByte(o.topSpeedKph ?? 0);
  f[10] = clampByte(o.throttlePct ?? 0); // throttle position raw
  f[11] = clampByte(o.backlightByte ?? 0); // UNVERIFIED street/sport nibble
  f[12] = o.ignitionOn ? 128 : 64; // dex-verified IG on / vehicle off
  f[13] = clampByte(o.zeroToSixtyRaw ?? 0); // raw only, not a usable 0-60
  writeU24BE(f, 14, (o.tripKm ?? 0) * 10); // trip meter, /10 scale
  writeU16BE(f, 17, o.rpm ?? 0); // RPM across 17-18, no checksum here
  return f;
}

// 0x11 service / diagnostics. DTCs surface via the MIL bit (byte 10,
// bit 2, dex-verified) and the MIL blink code (byte 8).
export function buildService(o = {}) {
  const f = newInboundFrame(ID_SERVICE);
  f[2] = clampByte(o.fuelSensorFailure ?? 0);
  f[3] = clampByte(o.vehicleState1 ?? 0); // UNVERIFIED bit layout
  f[4] = o.serviceReminder ? 1 : 0;
  f[6] = clampByte(o.issByte ?? 0); // UNVERIFIED bit layout
  f[7] = clampByte(o.speedoSwVersion ?? 0); // UNVERIFIED
  const dtcCount = o.dtcCount ?? 0;
  f[8] = clampByte(dtcCount); // MIL blink code; count is a sim convention
  f[9] = clampByte(o.vehicleModelRaw ?? 0); // UNVERIFIED values
  f[10] = dtcCount > 0 ? 0x04 : 0x00; // bit 2 = MIL state
  f[11] = clampByte(o.isgBlinkCode ?? 0);
  f[12] = clampByte(o.turnIndicator ?? 0);
  f[13] = clampByte(o.connectorStatus ?? 0);
  f[14] = clampByte(o.clusterTheme ?? 0);
  f[17] = clampByte(o.captureScreenshot ?? 0);
  return f;
}

// 0x18 engine telemetry. The stock receiver consumes only the battery
// voltage (byte 11, raw x 0.1 V); the rest is Scoot's technical view.
export function buildEngine(o = {}) {
  const f = newInboundFrame(ID_ENGINE);
  f[2] = clampByte(o.engineLoadPct ?? 0); // UNVERIFIED scale
  writeU16BE(f, 3, o.accumFuelInjectionMs ?? 0); // UNVERIFIED units
  f[5] = clampByte(o.mapKpa ?? 0); // UNVERIFIED scale
  f[6] = clampByte(o.baroU714 ?? 0); // UNVERIFIED
  f[7] = clampByte(o.intakeTempC ?? 0); // UNVERIFIED offset
  f[8] = clampByte(o.engineTempC ?? 0);
  writeU16BE(f, 9, o.baroHpa ?? 1013); // UNVERIFIED scale
  f[11] = clampByte((o.batteryV ?? 12.6) * 10); // dex-verified: raw x 0.1 V
  writeU16BE(f, 12, o.runTimeS ?? 0);
  writeU16BE(f, 14, (o.distanceKm ?? 0) * 10); // UNVERIFIED basis
  writeU16BE(f, 16, o.fuelInjectionMl ?? 0); // UNVERIFIED units
  return f;
}

// 0x19 economy / DTE / ISS.
export function buildEconomy(o = {}) {
  const f = newInboundFrame(ID_ECONOMY);
  writeU24BE(f, 2, o.issDurationRaw ?? 0); // UNVERIFIED units
  f[5] = clampByte(o.otaStatus ?? 0);
  f[8] = clampByte(o.avgKmpl ?? 0);
  f[9] = clampByte(o.instantKmpl ?? 0);
  writeU16BE(f, 11, o.dteKm ?? 0); // big-endian, dex-verified
  writeU24BE(f, 15, o.issCountRaw ?? 0);
  return f;
}

// 0x6B music button. command is a MUSIC_COMMANDS value (0-6).
export function buildMusicButton(command) {
  const f = newInboundFrame(ID_MUSIC);
  f[2] = clampByte(command);
  return f;
}

// ---------------------------------------------------------------------------
// Outbound decoders (phone -> cluster). decodeOutbound returns a plain
// object with { known, kind, ...fields }. kind 'ignored' means a frame the
// app legitimately sends that the sim counts as known but does not need
// to display (0x5A/0xF1 brightness, 0x73 calibration).
// ---------------------------------------------------------------------------

const _textDecoder =
  typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

// Decode zero-padded text from [start, endExclusive).
export function decodeText(bytes, start, endExclusive) {
  let end = Math.min(endExclusive, bytes.length);
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0x00) {
      end = i;
      break;
    }
  }
  const slice = bytes.slice(start, end);
  if (_textDecoder) return _textDecoder.decode(slice);
  return String.fromCharCode.apply(null, Array.from(slice));
}

function readU16BE(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) & 0xffff;
}

function readU24BE(bytes, offset) {
  return (
    ((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]) &
    0xffffff
  );
}

const MEDIA_FIELDS = {
  [ID_MEDIA_TITLE]: 'title',
  [ID_MEDIA_ARTIST]: 'artist',
  [ID_MEDIA_ALBUM]: 'album',
}; // dataId -> field mapping is UNVERIFIED per PROTOCOL.md

// Nav-text sanitization: Scoot's ASCII fallback (mirrors
// sanitizeClusterText in jupiter_text.dart, dex-verified): anything
// outside [A-Za-z0-9 space @] becomes 'X', trimmed, then cut to 17 bytes
// preferring a word boundary so the cluster never shows half-words.
export function sanitizeNavText(instruction) {
  const clean = String(instruction ?? '')
    .replace(/[^A-Za-z0-9 @]/g, 'X')
    .trim();
  const bytes = Buffer_fromUtf8(clean);
  if (bytes.length <= 17) return clean;
  let cut = _truncateUtf8Bytes(clean, 17);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.substring(0, space);
  return cut.trim();
}

function Buffer_fromUtf8(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
  }
  return out;
}

function _truncateUtf8Bytes(input, maxBytes) {
  const bytes = Buffer_fromUtf8(input);
  if (bytes.length <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const slice = bytes.slice(0, end);
  if (_textDecoder) return _textDecoder.decode(slice);
  return String.fromCharCode.apply(null, Array.from(slice));
}

export function decodeOutbound(bytes) {
  if (!(bytes instanceof Uint8Array)) return { known: false, kind: 'bad-type' };
  const id = bytes[1];
  // 0x43 caller packets can exceed 20 bytes with non-ASCII text; 0x50
  // pictogram frames are always 21 bytes ([FF, 00] tail). Everything
  // else is exactly 20.
  const longOk =
    (id === ID_CALLER || id === ID_PICTOGRAM) && bytes.length >= 20;
  if (bytes.length !== FRAME_SIZE && !longOk) {
    return { known: false, kind: 'bad-length' };
  }
  if (bytes[bytes.length - 1] !== END_BYTE && id !== ID_PICTOGRAM) {
    return { known: false, kind: 'bad-end' };
  }
  const start = bytes[0];
  // 0x5A lead byte is legal ONLY for nav-control (ID 0x4E) and
  // vehicle-control (ID 0xF1) outbound frames (Dart: jupiter_navigation
  // buildNavControlFrame, jupiter_settings buildVehicleControlFrame).
  // It stays bad-start for every other ID.
  const start5aOk =
    start === 0x5a && (id === ID_NAV_CONTROL || id === ID_VEHICLE_CONTROL);
  if (start !== START_PHONE && !start5aOk) {
    return { known: false, kind: 'bad-start' };
  }

  // Standard checksum check where the phone-side formula applies.
  const checksumApplies =
    start === START_PHONE &&
    id !== ID_CALIBRATION &&
    id !== ID_VEHICLE_CONTROL;
  const checksumValid = checksumApplies
    ? bytes[CHECKSUM_INDEX] === jupiterChecksum(bytes.subarray(0, 18))
    : null;

  switch (id) {
    case ID_MOBILE_DATA:
      return {
        known: true,
        kind: 'mobile-data',
        checksumValid,
        signalBars: (bytes[2] >> 4) & 0x0f,
        batteryBucket: bytes[2] & 0x0f,
        overspeedLimit: bytes[3],
        ambientTempC: bytes[4] - 40,
        time: {
          hour12: bytes[6],
          minute: bytes[7],
          second: bytes[8],
          pm: bytes[9] === 1,
        },
        missedCalls: bytes[10],
        networkType: bytes[11],
        date: { day: bytes[12], month: bytes[13], year: 2000 + bytes[14] },
        findMe: bytes[17] === 0x01,
      };
    case ID_TEXT_ROW1:
    case ID_TEXT_ROW2:
      return {
        known: true,
        kind: 'text',
        checksumValid,
        row: id === ID_TEXT_ROW1 ? 1 : 2,
        text: decodeText(bytes, 2, 19),
      };
    case ID_REGISTRATION:
      return {
        known: true,
        kind: 'registration',
        checksumValid,
        name: decodeText(bytes, 2, 19),
      };
    case ID_NAV_CONTROL:
      return {
        known: true,
        kind: 'nav-control',
        distanceM: readU16BE(bytes, 2),
        etaMinutes: readU16BE(bytes, 4),
        remainingTripM: readU24BE(bytes, 6),
        pictogram: bytes[9],
        rowCount: bytes[10],
        navStatus: bytes[11],
      };
    case ID_NAV_TEXT:
      return {
        known: true,
        kind: 'nav-text',
        text: decodeText(bytes, 2, 19),
      };
    case ID_CALLER: {
      const subNames = {
        [CALLER_SUB.nationalNumber]: 'national-number',
        [CALLER_SUB.contactName]: 'contact-name',
        [CALLER_SUB.countryCode]: 'country-code',
      };
      return {
        known: true,
        kind: 'caller',
        sub: bytes[2],
        subName: subNames[bytes[2]] ?? 'unknown',
        text: decodeText(bytes, 3, bytes.length - 1),
      };
    }
    case ID_PICTOGRAM:
      return {
        known: true,
        kind: 'pictogram',
        name: decodeText(bytes, 2, bytes.length - 2),
      };
    case ID_MEDIA_TITLE:
    case ID_MEDIA_ARTIST:
    case ID_MEDIA_ALBUM:
      return {
        known: true,
        kind: 'media-meta',
        field: MEDIA_FIELDS[id],
        text: decodeText(bytes, 2, 19),
      };
    case ID_USER_ID: {
      // Big-endian payload at bytes 2..17, trailing-zero padded, with a
      // 0x00 sign prefix for short values (mirrors BigInteger.toByteArray).
      let end = 18;
      while (end > 2 && bytes[end - 1] === 0x00) end--;
      let start2 = 2;
      while (start2 < end - 1 && bytes[start2] === 0x00) start2++;
      let userId = 0;
      for (let i = start2; i < end; i++) userId = userId * 256 + bytes[i];
      return { known: true, kind: 'user-id', userId };
    }
    case ID_VEHICLE_CONTROL:
      // 0x5A 0xF1 brightness frame. Known; the sim ignores it.
      return {
        known: true,
        kind: 'ignored',
        ignoredId: 'vehicle-control',
        brightnessWireByte: bytes[2],
      };
    case ID_CALIBRATION:
      // 0x73 calibration frame. Known; cluster acceptance is UNVERIFIED,
      // the sim ignores it.
      return {
        known: true,
        kind: 'ignored',
        ignoredId: 'calibration',
        b2: bytes[2],
        b1: bytes[3],
        valueLE32:
          (bytes[5] |
            (bytes[6] << 8) |
            (bytes[7] << 16) |
            (bytes[8] << 24)) >>>
          0,
        checksumValid:
          bytes[9] === calibrationChecksum(bytes),
      };
    default:
      return { known: false, kind: 'unknown', id };
  }
}
