// Frame-stream record and replay for the Scoot scooter simulator.
//
// Recording captures the BLE wire traffic between the sim and the app:
//   - outbound frames (sim -> app): taken from the engine's 'frame' events
//   - inbound frames (app -> sim): pushed in by the transport shim via
//     recorder.recordInbound(hex) whenever a frame arrives from the app
//
// Each line of the recording is JSON:
//   { "t": 1234, "dir": "in" | "out", "hex": "a1b2c3..." }
// where t is milliseconds since the recording started.
//
// Replay feeds only the 'in' frames (the ones the app sent earlier) back
// through engine.receiveFromApp() at their original timing, driven by
// tick(nowMs) from the sim main loop. 'out' frames are kept in the file
// as a reference of what the sim emitted, but are not replayed.
//
// No DOM in this file. Downloading is the UI's job: the UI calls
// recorder.getJsonl() and saves the string itself.

'use strict';

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// Accept a hex string, a Uint8Array/Buffer, or an object with a hex
// field, and return a clean lowercase hex string.
export function normalizeHex(frame) {
  let hex;
  if (typeof frame === 'string') {
    hex = frame;
  } else if (frame && typeof frame.hex === 'string') {
    hex = frame.hex;
  } else if (
    frame instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(frame))
  ) {
    hex = Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    throw new Error('recorder: frame is not a hex string, byte array or { hex } object');
  }
  hex = String(hex).replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('recorder: frame is not valid even-length hex');
  }
  return hex;
}

// Subscribe to an emitter with whatever API it offers: the project bus
// style on()/off(), DOM style addEventListener(), or Node style
// addListener(). Returns an unsubscribe function.
function subscribe(emitter, event, fn) {
  if (typeof emitter.on === 'function') {
    emitter.on(event, fn);
    if (typeof emitter.off === 'function') return () => emitter.off(event, fn);
    if (typeof emitter.removeListener === 'function') return () => emitter.removeListener(event, fn);
    return () => {};
  }
  if (typeof emitter.addEventListener === 'function') {
    emitter.addEventListener(event, fn);
    return () => emitter.removeEventListener(event, fn);
  }
  if (typeof emitter.addListener === 'function') {
    emitter.addListener(event, fn);
    return () => emitter.removeListener(event, fn);
  }
  throw new Error('recorder: engine has no event subscription API (need on() or addEventListener())');
}

// Parse a JSONL recording. Tolerates blank lines and skips malformed
// lines, reporting their 1-based line numbers. Frames are sorted by t.
export function parseRecording(text) {
  const frames = [];
  const skipped = [];
  String(text || '')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        const hex = normalizeHex(o.hex);
        frames.push({
          t: Math.max(0, Math.round(Number(o.t) || 0)),
          dir: o.dir === 'in' ? 'in' : 'out',
          hex,
        });
      } catch (err) {
        skipped.push(i + 1);
      }
    });
  frames.sort((a, b) => a.t - b.t);
  return { frames, skipped };
}

export function recordingStats(frames) {
  return {
    total: frames.length,
    inbound: frames.filter((f) => f.dir === 'in').length,
    outbound: frames.filter((f) => f.dir === 'out').length,
    durationMs: frames.length ? frames[frames.length - 1].t : 0,
  };
}

// Recorder: start(engine) begins capture, recordInbound(hex) logs
// app->sim frames from the transport shim, stop() ends capture and
// returns a summary, getJsonl() returns the file contents.
export function createRecorder() {
  let rec = null; // { lines, t0, unsubscribe }
  let lastLines = []; // retained after stop() so getJsonl() still works

  function start(engine) {
    if (!engine) throw new Error('recorder: start() needs an engine');
    if (rec) stop();
    rec = { lines: [], t0: nowMs(), unsubscribe: null };
    const onFrame = (frame) => {
      if (!rec) return;
      try {
        rec.lines.push({ t: Math.round(nowMs() - rec.t0), dir: 'out', hex: normalizeHex(frame) });
      } catch (err) {
        console.warn('[recorder] skipping non-hex frame event:', err.message);
      }
    };
    rec.unsubscribe = subscribe(engine, 'frame', onFrame);
    return api;
  }

  function recordInbound(hex) {
    if (!rec) return false;
    try {
      rec.lines.push({ t: Math.round(nowMs() - rec.t0), dir: 'in', hex: normalizeHex(hex) });
      return true;
    } catch (err) {
      console.warn('[recorder] skipping invalid inbound frame:', err.message);
      return false;
    }
  }

  function stop() {
    if (!rec) return null;
    lastLines = rec.lines;
    const summary = {
      frames: rec.lines.length,
      durationMs: Math.round(nowMs() - rec.t0),
      stats: recordingStats(rec.lines),
      jsonl: lastLines.map((l) => JSON.stringify(l)).join('\n') + (lastLines.length ? '\n' : ''),
    };
    try {
      if (rec.unsubscribe) rec.unsubscribe();
    } catch (err) {
      console.warn('[recorder] unsubscribe failed:', err.message);
    }
    rec = null;
    return summary;
  }

  function isRecording() {
    return rec !== null;
  }

  function frameCount() {
    return rec ? rec.lines.length : 0;
  }

  function getJsonl() {
    const lines = rec ? rec.lines : lastLines;
    return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  }

  const api = { start, stop, isRecording, recordInbound, frameCount, getJsonl };
  return api;
}

// Replayer: feeds the 'in' frames of a parsed recording through
// engine.receiveFromApp() at their original timing.
//
//   const rp = createReplayer();
//   rp.on('progress', ...); rp.on('done', ...); rp.on('error', ...);
//   rp.start(engine, frames);   // frames from parseRecording()
//   // each main-loop tick: rp.tick(nowMs)
//   rp.stop();
//
// How timing works: start() notes the first tick's timestamp as t0.
// On every tick, all 'in' frames whose recorded t is at or before
// (nowMs - t0) are fed in order. A frame recorded at t=1200 is fed
// 1200 ms after replay start, so the engine sees the same cadence as
// during the original session. 'out' frames are ignored.
export function createReplayer() {
  const handlers = new Map();
  let active = null;

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = handlers.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[replayer] handler for "' + event + '" threw:', err);
      }
    }
  }

  function start(engine, frames) {
    if (!engine || typeof engine.receiveFromApp !== 'function') {
      throw new Error('replayer: engine.receiveFromApp(hex) is missing');
    }
    const list = Array.isArray(frames) ? frames : [];
    const inbound = list
      .filter((f) => f && f.dir === 'in' && typeof f.hex === 'string')
      .map((f) => ({ t: Math.max(0, Math.round(Number(f.t) || 0)), hex: f.hex }))
      .sort((a, b) => a.t - b.t);
    if (active) stop();
    active = {
      engine,
      queue: inbound,
      total: inbound.length,
      fed: 0,
      errors: [],
      t0: null,
      ignoredOut: list.length - inbound.length,
    };
    emit('start', { total: active.total, ignoredOut: active.ignoredOut });
    return api;
  }

  function tick(nowMs) {
    if (!active) return;
    if (active.t0 === null) active.t0 = nowMs;
    const elapsed = nowMs - active.t0;
    while (active.queue.length && active.queue[0].t <= elapsed) {
      const f = active.queue.shift();
      try {
        active.engine.receiveFromApp(f.hex);
      } catch (err) {
        const record = { frame: f, error: String((err && err.message) || err) };
        active.errors.push(record);
        emit('error', record);
      }
      active.fed += 1;
      emit('frame', { frame: f, fed: active.fed, total: active.total });
    }
    emit('progress', {
      fed: active.fed,
      total: active.total,
      elapsedMs: Math.max(0, Math.round(elapsed)),
    });
    if (!active.queue.length) {
      const done = {
        fed: active.fed,
        total: active.total,
        errors: active.errors,
        ignoredOut: active.ignoredOut,
      };
      active = null;
      emit('done', done);
    }
  }

  function stop() {
    if (!active) return false;
    const left = active.queue.length;
    active = null;
    emit('stop', { remaining: left });
    return true;
  }

  function isReplaying() {
    return active !== null;
  }

  const api = { start, stop, tick, on, off, isReplaying };
  return api;
}
