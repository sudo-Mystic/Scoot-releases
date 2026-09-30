// Unit tests for the sim engine. Run from sim/:
//   node --test src/engine/engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_SIZE,
  START_CLUSTER,
  START_PHONE,
  END_BYTE,
  ID_PRIMARY,
  ID_SERVICE,
  ID_ENGINE,
  ID_ECONOMY,
  ID_MUSIC,
  jupiterChecksum,
  calibrationChecksum,
  buildPrimary,
  buildService,
  buildEngine,
  buildEconomy,
  buildMusicButton,
  decodeOutbound,
  sanitizeNavText,
} from './frames.js';
import { createEngine } from './engine.js';
import { createEngine as createEngineFromIndex } from './index.js';

function collectFrames(engine) {
  const frames = [];
  engine.on('frame', (f) => frames.push(f));
  return frames;
}

function collectDisplay(engine) {
  const events = [];
  engine.on('display', (e) => events.push(e));
  return events;
}

// Fidelity gate (W2 F3): the engine withholds 'frame' emission until
// receiveFromApp() has been called at least once. Open the gate with a
// minimal valid app->cluster 0x4A frame.
function openLink(engine) {
  const f = new Uint8Array(20);
  f[0] = START_PHONE;
  f[1] = 0x4a;
  f[18] = jupiterChecksum(f.subarray(0, 18));
  f[19] = END_BYTE;
  engine.receiveFromApp(f);
}

function lastFrameWithId(frames, id) {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i][1] === id) return frames[i];
  }
  return null;
}

test('inbound builders: size, start byte, id, end byte', () => {
  const cases = [
    [buildPrimary({}), ID_PRIMARY],
    [buildService({}), ID_SERVICE],
    [buildEngine({}), ID_ENGINE],
    [buildEconomy({}), ID_ECONOMY],
    [buildMusicButton(0), ID_MUSIC],
  ];
  for (const [f, id] of cases) {
    assert.ok(f instanceof Uint8Array);
    assert.equal(f.length, FRAME_SIZE);
    assert.equal(f[0], START_CLUSTER, 'start byte 0x5A');
    assert.equal(f[1], id);
    assert.equal(f[FRAME_SIZE - 1], END_BYTE, 'end byte 0xFF');
  }
});

test('checksum matches the Dart reference formula', () => {
  assert.equal(jupiterChecksum(new Array(18).fill(0)), 255);
  assert.equal(jupiterChecksum(new Array(18).fill(1)), 255 - 18);
  const bytes = Array.from({ length: 18 }, (_, i) => i);
  const sum = bytes.reduce((a, b) => a + b, 0);
  assert.equal(jupiterChecksum(bytes), 255 - (sum % 256));
});

test('0x10 round trip: speed, odo, fuel, ignition, rpm', () => {
  const engine = createEngine();
  const frames = collectFrames(engine);
  openLink(engine); // fidelity gate: first app write opens frame emission
  engine.controls.setIgnition(true);
  engine.controls.setFuelLiters(2.55); // half of the 5.1 L tank
  engine.tick(100);
  const f = lastFrameWithId(frames, ID_PRIMARY);
  assert.ok(f, '0x10 emitted');
  assert.equal(f[2], 0, 'speed byte at rest');
  const odoRaw = (f[3] << 16) | (f[4] << 8) | f[5];
  assert.ok(Math.abs(odoRaw / 10 - 1234.5) < 0.05, 'odo /10 matches state');
  assert.ok(
    f[6] === 127 || f[6] === 128,
    `fuel byte = round(0.5 * 255), got ${f[6]}`,
  );
  assert.equal(f[12], 128, 'ignition on byte');
  const rpm = (f[17] << 8) | f[18];
  assert.equal(rpm, 1400, 'idle rpm');
});

test('physics: odo integrates speed, speed follows throttle', () => {
  const engine = createEngine();
  const before = engine.getState();
  engine.controls.setIgnition(true);
  engine.controls.setThrottle(100);
  for (let i = 0; i < 100; i++) engine.tick(100); // 10 s sim time
  const after = engine.getState();
  assert.ok(after.speedKph > 50, `speed rose, got ${after.speedKph}`);
  assert.ok(after.odoKm - before.odoKm > 0.1, 'odo grew');
  assert.ok(after.tripA > 0.1, 'trip A grew');
  assert.ok(after.rpm > 1400, 'rpm above idle');
  assert.ok(after.fuelLiters < before.fuelLiters, 'fuel burned');
});

test('physics: ignition off coasts to a stop', () => {
  const engine = createEngine();
  engine.controls.setIgnition(true);
  engine.controls.setThrottle(100);
  for (let i = 0; i < 50; i++) engine.tick(100);
  engine.controls.setIgnition(false);
  for (let i = 0; i < 600; i++) engine.tick(100); // 60 s coast
  const s = engine.getState();
  assert.equal(s.speedKph, 0, 'coasted to stop');
  assert.equal(s.rpm, 0, 'rpm zero with key off');
  assert.equal(s.ignition, false);
});

test('trip reset is sim-side and reflected in 0x10', () => {
  const engine = createEngine();
  const frames = collectFrames(engine);
  openLink(engine); // fidelity gate: first app write opens frame emission
  engine.controls.setIgnition(true);
  engine.controls.setThrottle(60);
  for (let i = 0; i < 50; i++) engine.tick(100);
  assert.ok(engine.getState().tripA > 0);
  engine.controls.resetTrip('A');
  assert.equal(engine.getState().tripA, 0);
  assert.ok(engine.getState().tripB > 0, 'trip B untouched');
  frames.length = 0;
  engine.tick(100);
  const f = lastFrameWithId(frames, ID_PRIMARY);
  const tripRaw = (f[14] << 16) | (f[15] << 8) | f[16];
  assert.equal(tripRaw, 0, '0x10 trip bytes zeroed after reset');
});

test('DTC inject shows in the next 0x11 (immediate, not on cadence)', () => {
  const engine = createEngine();
  const frames = collectFrames(engine);
  openLink(engine); // fidelity gate: first app write opens frame emission
  engine.tick(100); // emits 0x11, arms the 5 s cadence
  frames.length = 0;
  engine.controls.injectDtc('P0123');
  engine.tick(50); // far short of the 5 s cadence
  const f = lastFrameWithId(frames, ID_SERVICE);
  assert.ok(f, '0x11 emitted immediately on DTC change');
  assert.ok((f[10] & 0x04) !== 0, 'MIL bit (byte 10 bit 2) set');
  assert.ok(f[8] > 0, 'MIL blink code nonzero');
  assert.deepEqual(engine.getState().dtcs, ['P0123']);
  engine.controls.clearDtcs();
  frames.length = 0;
  engine.tick(50);
  const f2 = lastFrameWithId(frames, ID_SERVICE);
  assert.ok(f2, '0x11 emitted on clear');
  assert.equal(f2[10] & 0x04, 0, 'MIL bit cleared');
});

test('outbound 0x4A decodes to a link display event', () => {
  const engine = createEngine();
  const events = collectDisplay(engine);
  const f = new Uint8Array(20);
  f[0] = START_PHONE;
  f[1] = 0x4a;
  f[2] = (4 << 4) | 3;
  f[3] = 120;
  f[4] = 40; // 0 C
  f[6] = 10;
  f[7] = 30;
  f[8] = 0;
  f[9] = 0; // AM
  f[10] = 2; // missed calls
  f[11] = 4; // LTE
  f[12] = 30;
  f[13] = 9;
  f[14] = 26;
  f[18] = jupiterChecksum(f.subarray(0, 18));
  f[19] = END_BYTE;
  const d = decodeOutbound(f);
  assert.equal(d.kind, 'mobile-data');
  assert.equal(d.checksumValid, true);
  const r = engine.receiveFromApp(f);
  assert.equal(r.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'link');
  assert.equal(events[0].signalBars, 4);
  assert.equal(events[0].ambientTempC, 0);
  assert.equal(events[0].missedCalls, 2);
  assert.equal(events[0].findMe, false);
});

test('outbound 0x4F decodes to navtext event (sanitized, newer wins)', () => {
  const engine = createEngine();
  const events = collectDisplay(engine);
  const named = [];
  engine.on('navtext', (e) => named.push(e));
  const text = 'Turn left onto MG Road then continue';
  const f = new Uint8Array(20);
  f[0] = START_PHONE;
  f[1] = 0x4f;
  const tb = new TextEncoder().encode(text.slice(0, 17));
  f.set(tb, 2);
  f[19] = END_BYTE;
  const r = engine.receiveFromApp(f);
  assert.equal(r.ok, true);
  assert.equal(named.length, 1);
  assert.equal(named[0].text, 'Turn left onto MG', 'word-boundary cut');
  assert.equal(events[0].type, 'nav');
  assert.equal(events[0].navText, 'Turn left onto MG');
  // Newer supersedes: send again with different text.
  const f2 = new Uint8Array(20);
  f2[0] = START_PHONE;
  f2[1] = 0x4f;
  f2.set(new TextEncoder().encode('Arrived'), 2);
  f2[19] = END_BYTE;
  engine.receiveFromApp(f2);
  assert.equal(named[1].text, 'Arrived');
});

test('sanitizeNavText maps non-cluster chars and trims', () => {
  assert.equal(sanitizeNavText('Hi!'), 'HiX');
  assert.equal(sanitizeNavText('a'.repeat(30)), 'a'.repeat(17));
});

test('outbound 0x5A/0xF1 emits brightness level, does not touch physics', () => {
  const engine = createEngine();
  const levels = [];
  engine.on('brightness', (e) => levels.push(e.level));
  const display = collectDisplay(engine);
  const before = engine.getState();
  const f = new Uint8Array([
    0x5a, 0xf1, 6, 9, 0, 2, 0, 0, 0, 30, 0, 8, 0, 26, 0, 1, 1, 0, 0, 0xff,
  ]);
  const r = engine.receiveFromApp(f);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ignored');
  assert.deepEqual(levels, [3], 'wire 6 -> level 3');
  assert.equal(display.length, 0, 'no display event for brightness');
  const after = engine.getState();
  assert.equal(after.speedKph, before.speedKph);
  // Wire byte 1 -> level 1.
  const f1 = new Uint8Array(f);
  f1[2] = 1;
  engine.receiveFromApp(f1);
  assert.deepEqual(levels, [3, 1]);
});

test('outbound 0x73 calibration is known and ignored', () => {
  const engine = createEngine();
  const display = collectDisplay(engine);
  const named = [];
  engine.on('navtext', (e) => named.push(e));
  engine.on('brightness', (e) => named.push(e));
  const f = new Uint8Array(20);
  f[0] = START_PHONE;
  f[1] = 0x73;
  f[2] = 0; // b2
  f[3] = 18; // b1: follow-me-home timer
  f[4] = 4;
  const v = 30;
  f[5] = v & 0xff;
  f[6] = (v >> 8) & 0xff;
  f[7] = (v >> 16) & 0xff;
  f[8] = (v >> 24) & 0xff;
  f[9] = calibrationChecksum(f);
  f[19] = END_BYTE;
  const d = decodeOutbound(f);
  assert.equal(d.known, true);
  assert.equal(d.kind, 'ignored');
  assert.equal(d.b1, 18);
  assert.equal(d.valueLE32, 30);
  const r = engine.receiveFromApp(f);
  assert.equal(r.ok, true);
  assert.equal(display.length, 0);
  assert.equal(named.length, 0);
});

test('pressMusicButton emits 0x6B with the dex command byte', () => {
  const engine = createEngine();
  const frames = collectFrames(engine);
  openLink(engine); // fidelity gate: first app write opens frame emission
  engine.controls.pressMusicButton('next');
  engine.controls.pressMusicButton('volup');
  assert.equal(frames.length, 2);
  assert.equal(frames[0][1], ID_MUSIC);
  assert.equal(frames[0][2], 3, 'next = 3');
  assert.equal(frames[1][2], 5, 'volup = 5');
});

test('engine.on/off subscribe and unsubscribe', () => {
  const engine = createEngine();
  let n = 0;
  const fn = () => n++;
  engine.on('frame', fn);
  openLink(engine); // fidelity gate: first app write opens frame emission
  engine.tick(100);
  assert.ok(n > 0);
  engine.off('frame', fn);
  const m = n;
  engine.tick(100);
  assert.equal(n, m, 'listener removed');
});

test('fidelity gate: no frames until the first app write; linkready fires once', () => {
  const engine = createEngine();
  const frames = collectFrames(engine);
  const ready = [];
  engine.on('linkready', (e) => ready.push(e));
  engine.tick(100);
  engine.tick(100);
  assert.equal(frames.length, 0, 'no frames before any app write');
  assert.equal(ready.length, 0, 'no linkready before any app write');
  // Physics still advances while the gate is shut.
  const before = engine.getState();
  engine.controls.setIgnition(true);
  engine.controls.setThrottle(50);
  engine.tick(1000);
  assert.ok(engine.getState().simTimeMs > before.simTimeMs, 'tick() advances sim time');
  assert.ok(engine.getState().odoKm > before.odoKm, 'physics advances');
  openLink(engine);
  assert.equal(ready.length, 1, 'linkready emitted once on the first write');
  engine.tick(100);
  assert.ok(frames.length > 0, 'frames flow after the first app write');
  openLink(engine);
  assert.equal(ready.length, 1, 'linkready does not fire again');
});

test('createEngine accepts id string, {profile}, or nothing; index re-export works', () => {
  const a = createEngine();
  const b = createEngine('jupiter110');
  const c = createEngine({ profile: 'jupiter110' });
  const d = createEngineFromIndex();
  for (const e of [a, b, c, d]) {
    assert.equal(e.getState().profileId, 'jupiter110');
    assert.equal(typeof e.tick, 'function');
    assert.equal(typeof e.receiveFromApp, 'function');
    assert.equal(typeof e.controls.setIgnition, 'function');
  }
  assert.throws(() => createEngine('nope'), /unknown profile/);
  const e = createEngine();
  e.registerProfile({
    id: 'custom',
    label: 'Custom',
    tankCapacityL: 5,
    encodeFuelByte: (x) => Math.round(x * 100),
    decodeNotes: '',
    frameCadenceMs: { primary: 100, service: 5000, engine: 1000, economy: 1000 },
  });
  e.setProfile('custom');
  assert.equal(e.getState().profileId, 'custom');
});
