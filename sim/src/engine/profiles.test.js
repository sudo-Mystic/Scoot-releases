// Self-test for the vehicle profiles. Run with:
//   node --test src/engine/profiles.test.js
// (run from ~/workspace/scoot-releases/sim/)
// Zero deps beyond the node:test runner.
'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, getProfile, listProfileIds } from './profiles.js';

const LEVELS = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
const QUANT = 1 / 15; // fuel gauge quantization step

for (const id of listProfileIds()) {
  const p = PROFILES[id];

  test(`${id}: registry shape is complete`, () => {
    assert.equal(p.id, id);
    assert.ok(typeof p.label === 'string' && p.label.length > 0);
    assert.equal(typeof p.encodeFuelByte, 'function');
    assert.equal(typeof p.decodeFuelByte, 'function');
    assert.match(p.serviceUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(p.writeUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(p.notifyUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const frameId of [0x10, 0x11, 0x18, 0x19]) {
      assert.ok(
        typeof p.frameCadenceMs[frameId] === 'number' && p.frameCadenceMs[frameId] > 0,
        `missing cadence for 0x${frameId.toString(16)}`,
      );
    }
    assert.ok(Array.isArray(p.notes) && p.notes.length > 0);
  });

  test(`${id}: encodeFuelByte/decodeFuelByte round-trips within quantization`, () => {
    for (const level of LEVELS) {
      const byte = p.encodeFuelByte(level);
      assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255, `byte out of range: ${byte}`);
      const back = p.decodeFuelByte(byte);
      assert.ok(Math.abs(back - level) <= QUANT / 2 + 1e-9, `round-trip drift: ${level} -> ${byte} -> ${back}`);
    }
  });

  test(`${id}: decode ignores the upper nibble except via the nibble rule`, () => {
    // Same low nibble, different upper nibbles: decode must agree for the
    // low-nibble models; for the 110 the upper nibble is the reserve flag
    // and must not move the decoded level either.
    const a = p.decodeFuelByte(0x05);
    const b = p.decodeFuelByte(0x85);
    assert.equal(a, b);
    assert.equal(a, 5 / 15);
  });

  test(`${id}: encode is monotonic and clamps out-of-range input`, () => {
    const bytes = LEVELS.map((l) => p.encodeFuelByte(l) & 0x0f);
    for (let i = 1; i < bytes.length; i++) {
      assert.ok(bytes[i] >= bytes[i - 1], `non-monotonic at level ${LEVELS[i]}`);
    }
    assert.equal(p.encodeFuelByte(-1) & 0x0f, p.encodeFuelByte(0) & 0x0f);
    assert.equal(p.encodeFuelByte(2) & 0x0f, p.encodeFuelByte(1) & 0x0f);
  });
}

test('all profiles share the same GATT UUID family', () => {
  const uuids = listProfileIds().map((id) => getProfile(id).serviceUuid);
  assert.ok(uuids.every((u) => u === uuids[0]));
});

test('jupiter110 reserve flag behavior (sim convention)', () => {
  const p = getProfile('jupiter110');
  // Low fuel sets the upper nibble (reserve marker); high fuel clears it.
  assert.notEqual(p.encodeFuelByte(0.05) & 0xf0, 0);
  assert.equal(p.encodeFuelByte(0.8) & 0xf0, 0);
  // Decoded level still comes from the low nibble either way.
  assert.equal(p.decodeFuelByte(p.encodeFuelByte(0.05)), Math.round(0.05 * 15) / 15);
});

test('jupiter125 zeroes the upper nibble on encode', () => {
  const p = getProfile('jupiter125');
  for (const level of LEVELS) {
    assert.equal(p.encodeFuelByte(level) & 0xf0, 0);
  }
});

test('ntorq outbound mask is 0xEB, jupiter profiles unmasked', () => {
  assert.equal(getProfile('ntorq').extras.outboundXorMask, 0xeb);
  assert.equal(getProfile('jupiter110').extras.outboundXorMask, 0);
  assert.equal(getProfile('jupiter125').extras.outboundXorMask, 0);
});

test('getProfile throws on unknown id', () => {
  assert.throws(() => getProfile('vespa'), /unknown vehicle profile/);
});
