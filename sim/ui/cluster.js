// Virtual TVS Jupiter TFT cluster for the Scoot Scooter Simulator.
//
// Renders EXACTLY what the real cluster displays, driven only by decoded
// app frames (display events) and engine.getState(). Idle with no app
// traffic: the ride screen with engine state.
//
// PROTOCOL AUTHORITY (do not invent layouts):
// - lib/vehicles/tvs_jupiter/jupiter_navigation.dart  0x5A/0x4E control,
//   0x4F nav text, maneuver catalog 0-8 / 11-21 / 40-41 / 65-71 / 82-88
// - lib/vehicles/tvs_jupiter/jupiter_text.dart        0x4C/0x63 rows
//   (2 rows x 17 chars), 0x43 caller (subIds 01/02/03), 0x50 pictogram
//   ([5B,50] + name + pad + [FF,00]), 0x61/0x62/0x65 media
// - lib/vehicles/tvs_jupiter/jupiter_mobile_data.dart 0x4A link/env/clock
// - lib/vehicles/tvs_jupiter/jupiter_constants.dart   frame IDs, timing
// - lib/vehicles/tvs_jupiter/jupiter_telemetry.dart   0x10 state fields
//
// Anything marked UNVERIFIED below is a best-effort rendering choice, not
// a documented cluster behavior.
//
// Design Read: a functional instrument-panel webapp for a developer
// audience, with a dark-instrument language, leaning toward native canvas
// rendering + near-black/volt-lime tokens. Dials: VARIANCE 3, MOTION 3,
// DENSITY 9 (cockpit).

// ---------------------------------------------------------------------------
// Frame IDs (mirror JupiterId / JupiterFrame)
// ---------------------------------------------------------------------------
const ID = {
  start: 0x5b,
  mobileData: 0x4a,
  msgRow1: 0x4c,
  msgRow2: 0x63,
  navControl0: 0x5a,
  navControl1: 0x4e,
  navText: 0x4f,
  caller: 0x43,
  pictogram: 0x50,
  mediaTitle: 0x61,
  mediaArtist: 0x62,
  mediaAlbum: 0x65,
};

const CALLER_SUB = { national: 0x01, name: 0x02, country: 0x03 };

// Freshness windows
const NAV_FRESH_MS = 3000; // task requirement: HUD-drop banner past this
const NAV_DROP_MS = 10000; // then fall back to the ride screen
const CALL_MS = 15000;
const MEDIA_MS = 20000;
const MSG_MS = 30000;
const PICTO_MS = 8000;
const MOBILE_FRESH_MS = 120000; // clock source from 0x4A
const TEXT_CYCLE_MS = 3000; // JupiterTiming.textCycleMs

// ---------------------------------------------------------------------------
// Maneuver catalog: byte -> {kind, label, draw params}.
// Labels verbatim from jupiter_navigation.dart jupiterManeuverMap.
// Draw params: turn angles in degrees, 0 = straight up, negative = left.
// ---------------------------------------------------------------------------
const MANEUVERS = {
  0: { kind: 'turn', angle: -90, label: 'Sharp left' },
  1: { kind: 'turn', angle: -45, label: 'Slight left (alt)' },
  2: { kind: 'turn', angle: -45, label: 'Slight left' },
  3: { kind: 'turn', angle: 90, label: 'Sharp right' },
  4: { kind: 'turn', angle: 45, label: 'Slight right (alt)' },
  5: { kind: 'turn', angle: 45, label: 'Slight right' },
  6: { kind: 'uturn', dir: -1, label: 'U-turn left' },
  7: { kind: 'turn', angle: 0, label: 'Go straight' },
  8: { kind: 'arrived', label: 'Arrived' },
  11: { kind: 'fork', angle: -90, label: 'T-junction L' },
  12: { kind: 'fork', angle: 90, label: 'T-junction R' },
  13: { kind: 'fork', angle: -45, label: 'Left branch' },
  14: { kind: 'fork', angle: 45, label: 'Right branch' },
  15: { kind: 'fork', angle: -30, label: 'Fork left' },
  16: { kind: 'fork', angle: 30, label: 'Fork right' },
  17: { kind: 'fork', angle: -20, label: 'Merge left' },
  18: { kind: 'fork', angle: 20, label: 'Merge right' },
  19: { kind: 'fork', angle: -60, label: 'Exit left' },
  20: { kind: 'fork', angle: 60, label: 'Exit right' },
  21: { kind: 'fork', angle: 0, label: 'Crossroad' },
  40: { kind: 'noentry', label: 'No entry' },
  41: { kind: 'uturn', dir: 1, label: 'U-turn right' },
  65: { kind: 'rbt', angle: -45, label: 'Rbt slight left' },
  66: { kind: 'rbt', angle: -90, label: 'Rbt sharp left' },
  67: { kind: 'rbt', angle: 45, label: 'Rbt slight right' },
  68: { kind: 'rbt', angle: 0, label: 'Rbt straight' },
  69: { kind: 'rbt', angle: 90, label: 'Rbt right' },
  70: { kind: 'rbt', angle: 135, label: 'Rbt sharp right' },
  71: { kind: 'rbt', angle: 180, label: 'Rbt U-turn' },
  82: { kind: 'rbt', angle: 45, label: 'Rbt slight right (RH)' },
  83: { kind: 'rbt', angle: 90, label: 'Rbt right (RH)' },
  84: { kind: 'rbt', angle: -45, label: 'Rbt slight left (RH)' },
  85: { kind: 'rbt', angle: 0, label: 'Rbt straight (RH)' },
  86: { kind: 'rbt', angle: -90, label: 'Rbt left (RH)' },
  87: { kind: 'rbt', angle: -135, label: 'Rbt sharp left (RH)' },
  88: { kind: 'rbt', angle: 180, label: 'Rbt U-turn (RH)' },
};

// ---------------------------------------------------------------------------
// Raw frame decoding (app -> cluster, phone-to-cluster direction)
// ---------------------------------------------------------------------------
const _td = new TextDecoder('utf-8');

function _text(bytes, from, to) {
  let end = to;
  while (end > from && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0xff)) {
    end--;
  }
  if (end <= from) return '';
  try {
    return _td.decode(bytes.subarray(from, end));
  } catch {
    return '';
  }
}

function _isBytes(v) {
  return v instanceof Uint8Array || (Array.isArray(v) && v.every((x) => typeof x === 'number'));
}

/// Decode one raw app frame into a normalized display event.
/// Returns null for frames this cluster does not render.
function decodeFrame(raw) {
  const b = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  if (b.length < 2) return null;

  // Nav control frame uses the 0x5A start byte (JupiterId.navControl0);
  // everything else from the app uses 0x5B.
  if (b[0] === ID.navControl0 && b[1] === ID.navControl1 && b.length >= 12) {
    return {
      type: 'navControl',
      distanceM: (b[2] << 8) | b[3],
      etaMin: (b[4] << 8) | b[5],
      remainingM: (b[6] << 16) | (b[7] << 8) | b[8],
      pictogram: b[9],
      rowCount: b[10],
      navStatus: b[11],
      at: Date.now(),
    };
  }
  if (b[0] !== ID.start) return null;
  const id = b[1];
  switch (id) {
    case ID.msgRow1:
    case ID.msgRow2:
      return { type: 'text', row: id === ID.msgRow1 ? 1 : 2, text: _text(b, 2, b.length), at: Date.now() };
    case ID.navText:
      return { type: 'navText', text: _text(b, 2, b.length), at: Date.now() };
    case ID.caller: {
      const sub = b[2];
      const text = _text(b, 3, b.length);
      return { type: 'caller', subId: sub, text, at: Date.now() };
    }
    case ID.pictogram:
      return { type: 'pictogram', name: _text(b, 2, b.length), at: Date.now() };
    case ID.mobileData:
      if (b.length < 20) return null;
      return {
        type: 'mobile',
        signal: (b[2] >> 4) & 0x0f,
        batteryPct: (b[2] & 0x0f) * 25,
        overspeed: b[3],
        ambientC: b[4] - 40,
        hour: b[6],
        minute: b[7],
        second: b[8],
        pm: b[9] === 1,
        missed: b[10],
        network: b[11],
        day: b[12],
        month: b[13],
        year: 2000 + b[14],
        findMe: b[17] === 1,
        at: Date.now(),
      };
    case ID.mediaTitle:
    case ID.mediaArtist:
    case ID.mediaAlbum:
      return {
        type: 'media',
        field: id === ID.mediaTitle ? 'title' : id === ID.mediaArtist ? 'artist' : 'album',
        text: _text(b, 2, b.length),
        at: Date.now(),
      };
    default:
      return null;
  }
}

/// Accept the several event shapes the engine may emit; always returns a
/// normalized event or null. Defensive: W3's exact 'display' payload shape
/// was not visible at authoring time, so raw frames, {frame} wrappers, and
/// pre-decoded objects are all handled.
function normalizeEvent(ev) {
  if (!ev) return null;
  if (_isBytes(ev)) return decodeFrame(ev);
  if (typeof ev === 'object') {
    if (_isBytes(ev.frame)) return decodeFrame(ev.frame);
    if (_isBytes(ev.bytes)) return decodeFrame(ev.bytes);
    if (typeof ev.type === 'string') {
      const t = ev.type.toLowerCase();
      if (t === 'navcontrol' || t === 'nav') {
        return {
          type: 'navControl',
          distanceM: ev.distanceM ?? ev.distance ?? 0,
          etaMin: ev.etaMin ?? ev.etaMinutes ?? ev.eta ?? 0,
          remainingM: ev.remainingM ?? ev.remainingTripM ?? ev.remaining ?? 0,
          pictogram: ev.pictogram ?? 0,
          rowCount: ev.rowCount ?? 1,
          navStatus: ev.navStatus ?? 0x01,
          at: ev.at ?? Date.now(),
        };
      }
      if (t === 'navtext') return { type: 'navText', text: String(ev.text ?? ''), at: ev.at ?? Date.now() };
      if (t === 'text' || t === 'messagerow' || t === 'message') {
        return {
          type: 'text',
          row: ev.row === 2 ? 2 : 1,
          text: String(ev.text ?? ''),
          at: ev.at ?? Date.now(),
        };
      }
      if (t === 'caller' || t === 'call') {
        return {
          type: 'caller',
          subId: ev.subId,
          text: String(ev.text ?? ''),
          name: ev.name,
          number: ev.number,
          countryCode: ev.countryCode,
          at: ev.at ?? Date.now(),
        };
      }
      if (t === 'pictogram' || t === 'picto') {
        return { type: 'pictogram', name: String(ev.name ?? ev.text ?? ''), at: ev.at ?? Date.now() };
      }
      if (t === 'media') {
        return {
          type: 'media',
          field: ev.field,
          title: ev.title,
          artist: ev.artist,
          album: ev.album,
          text: ev.text,
          at: ev.at ?? Date.now(),
        };
      }
      if (t === 'mobile' || t === 'mobiledata') return { type: 'mobile', ...ev, at: ev.at ?? Date.now() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine state normalization (defensive across plausible key names)
// ---------------------------------------------------------------------------
const _num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const _int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

function readEngineState(engine) {
  let raw = {};
  try {
    if (engine && typeof engine.getState === 'function') raw = engine.getState() || {};
  } catch {
    raw = {};
  }
  const g = (...keys) => {
    for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k];
    return undefined;
  };
  return {
    speedKmh: _num(g('speedKmh', 'speedKph', 'speed', 'speed_kmh'), 0),
    odoKm: _num(g('odometerKm', 'odoKm', 'odometer', 'odo'), 0),
    tripAKm: _num(g('tripAKm', 'tripA', 'trip_a'), NaN),
    tripBKm: _num(g('tripBKm', 'tripB', 'trip_b'), NaN),
    tripKm: _num(g('tripKm', 'tripMeterKm'), NaN),
    // UNVERIFIED: bar count and low-fuel threshold are a provisional
    // interpretation of 0x10[6]; the 125 low-nibble and 110 raw-byte
    // forms differ (see decodePrimary).
    fuelBars: _int(g('fuelBars', 'fuelLevel', 'fuel'), 8),
    fuelBarsMax: _int(g('fuelBarsMax'), 8),
    reserve: !!g('reserve', 'lowFuel'),
    ignitionOn: g('ignitionOn', 'ignition') === undefined ? true : !!g('ignitionOn', 'ignition'),
    vehicleOff: !!g('vehicleOff'),
    engineTempC: _num(g('engineTempC', 'engineTemperature', 'engineTemp'), NaN),
    gear: g('gear', 'gearPos', 'gearLetter'),
    clock: g('clock', 'time', 'date'),
    powerMode: !!g('powerMode'),
    ecoMode: !!g('ecoMode'),
    // Malfunction indicator: the engine latches injected DTCs in `dtcs`.
    dtcCount: Array.isArray(g('dtcs')) ? g('dtcs').length : 0,
    milOn: Array.isArray(g('dtcs')) ? g('dtcs').length > 0 : !!g('milOn', 'mil'),
  };
}

// ---------------------------------------------------------------------------
// mount(rootEl, ctx)
// ctx = { engine, transport, bus }. engine emits 'display' events and
// exposes getState(). Returns { el, unmount, handleEvent, getScreen }.
// ---------------------------------------------------------------------------
export function mount(rootEl, ctx = {}) {
  if (!rootEl) throw new Error('[cluster] mount needs a root element');
  const { engine = null, bus = null } = ctx;

  const tokens = readTokens(rootEl);
  const T = tokens;

  // prefers-reduced-motion: live values still update; only the blink
  // animation of status changes (steady state instead of flashing).
  const REDUCED = typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Screen store: everything the cluster shows, keyed by source frame.
  const S = {
    nav: null, // {pictogram,distanceM,etaMin,remainingM,text,rowCount,navStatus,at}
    navText: '',
    call: null, // {name,number,at}
    callerParts: { national: '', country: '', name: '' },
    msg: { row1: '', row2: '', at: 0 },
    media: { title: '', artist: '', album: '', at: 0 },
    mobile: null,
    picto: null, // {name, at}
  };

  function applyEvent(ev) {
    if (!ev) return;
    const now = Date.now();
    switch (ev.type) {
      case 'navControl':
        S.nav = { ...ev, at: ev.at || now };
        break;
      case 'navText':
        S.navText = ev.text;
        if (S.nav) S.nav.at = ev.at || now; // text frames ride the keep-alive
        else S.nav = { pictogram: 7, distanceM: 0, etaMin: 0, remainingM: 0, rowCount: 1, navStatus: 1, at: ev.at || now };
        break;
      case 'text':
        S.msg['row' + ev.row] = ev.text;
        S.msg.at = ev.at || now;
        break;
      case 'caller': {
        const p = S.callerParts;
        if (ev.subId === CALLER_SUB.national) p.national = ev.text;
        else if (ev.subId === CALLER_SUB.country) p.country = ev.text;
        else if (ev.subId === CALLER_SUB.name) p.name = ev.text;
        else {
          if (ev.name) p.name = ev.name;
          if (ev.number) p.national = ev.number;
          if (ev.countryCode) p.country = ev.countryCode;
        }
        const number = (p.country ? '+' + p.country + ' ' : '') + (p.national || '');
        S.call = { name: p.name || 'Unknown', number: number || 'Unknown', at: ev.at || now };
        break;
      }
      case 'pictogram':
        S.picto = { name: ev.name, at: ev.at || now };
        break;
      case 'media': {
        const at = ev.at || now;
        if (ev.field === 'title' && ev.text !== undefined) S.media.title = ev.text;
        else if (ev.field === 'artist' && ev.text !== undefined) S.media.artist = ev.text;
        else if (ev.field === 'album' && ev.text !== undefined) S.media.album = ev.text;
        else {
          if (ev.title !== undefined) S.media.title = ev.title;
          if (ev.artist !== undefined) S.media.artist = ev.artist;
          if (ev.album !== undefined) S.media.album = ev.album;
        }
        S.media.at = at;
        break;
      }
      case 'mobile':
        S.mobile = { ...ev, at: ev.at || now };
        break;
      default:
        break;
    }
  }

  function handleEvent(raw) {
    applyEvent(normalizeEvent(raw));
  }

  // -- event wiring ---------------------------------------------------------
  const unsubs = [];
  function trySub(target, event, fn) {
    if (!target) return;
    try {
      if (typeof target.on === 'function') {
        const off = target.on(event, fn);
        if (typeof off === 'function') unsubs.push(off);
        else if (typeof target.off === 'function') unsubs.push(() => target.off(event, fn));
        return;
      }
      if (typeof target.addEventListener === 'function') {
        target.addEventListener(event, fn);
        unsubs.push(() => target.removeEventListener(event, fn));
      }
    } catch {
      /* ignore */
    }
  }
  // Engine is the documented 'display' source; bus is the sim fallback.
  trySub(engine, 'display', handleEvent);
  trySub(bus, 'display', handleEvent);

  // -- screen selection -------------------------------------------------------
  function screenAt(now) {
    if (S.call && now - S.call.at < CALL_MS) return 'call';
    if (S.nav) {
      const age = now - S.nav.at;
      if (age < NAV_FRESH_MS) return 'nav';
      if (age < NAV_DROP_MS) return 'nav-stale';
      S.nav = null;
      S.navText = '';
    }
    if (S.media.at && now - S.media.at < MEDIA_MS &&
        (S.media.title || S.media.artist || S.media.album)) return 'media';
    if (S.msg.at && now - S.msg.at < MSG_MS && (S.msg.row1 || S.msg.row2)) return 'message';
    return 'ride';
  }

  function clockParts(now) {
    if (S.mobile && now - S.mobile.at < MOBILE_FRESH_MS) {
      let h = S.mobile.hour % 12;
      if (h === 0) h = 12;
      return { h, m: S.mobile.minute, suffix: S.mobile.pm ? 'PM' : 'AM' };
    }
    // Engine-supplied clock when present; otherwise the sim host time.
    try {
      const st = readEngineState(engine);
      const c = st && st.clock;
      const d = c instanceof Date ? c : c ? new Date(c) : new Date();
      if (!Number.isNaN(d.getTime())) {
        let h = d.getHours() % 12;
        if (h === 0) h = 12;
        return { h, m: d.getMinutes(), suffix: d.getHours() >= 12 ? 'PM' : 'AM' };
      }
    } catch { /* fall through to host time */ }
    const d = new Date();
    let h = d.getHours() % 12;
    if (h === 0) h = 12;
    return { h, m: d.getMinutes(), suffix: d.getHours() >= 12 ? 'PM' : 'AM' };
  }

  // -- canvas setup (DPR-aware) ------------------------------------------------
  const LOGICAL_W = 480;
  const LOGICAL_H = 300;
  const canvas = document.createElement('canvas');
  canvas.className = 'sim-cluster';
  canvas.setAttribute('aria-label', 'Virtual Jupiter instrument cluster');
  Object.assign(canvas.style, {
    width: '100%',
    height: '100%',
    display: 'block',
    background: T.bgSunken,
    borderRadius: T.radius,
  });
  rootEl.appendChild(canvas);
  const g = canvas.getContext('2d');

  function resize() {
    const rect = rootEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // Fit the 480x300 instrument into the box, letterboxed.
    const scale = Math.min(canvas.width / LOGICAL_W, canvas.height / LOGICAL_H);
    const ox = (canvas.width - LOGICAL_W * scale) / 2;
    const oy = (canvas.height - LOGICAL_H * scale) / 2;
    g.setTransform(scale, 0, 0, scale, ox, oy);
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(rootEl);
  window.addEventListener('resize', resize);
  resize();

  // -- render loop -------------------------------------------------------------
  let raf = 0;
  let running = true;
  function frame() {
    if (!running) return;
    if (!document.hidden) {
      const now = Date.now();
      drawScreen(g, screenAt(now), { S, T, now, engine, W: LOGICAL_W, H: LOGICAL_H, clock: clockParts(now), reduced: REDUCED });
    }
    raf = requestAnimationFrame(frame);
  }
  function onVis() {
    // Pausing when hidden keeps the sim cheap; on return the loop resumes
    // and every screen re-derives from store timestamps (no stale paint).
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      resize();
      raf = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);

  function unmount() {
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', resize);
    if (ro) ro.disconnect();
    for (const u of unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    canvas.remove();
  }

  return {
    el: canvas,
    unmount,
    handleEvent,
    getScreen: () => screenAt(Date.now()),
    _store: S,
  };
}

function readTokens(rootEl) {
  const cs = getComputedStyle(rootEl);
  // No literal fallbacks: every color must resolve from tokens.css, which
  // the shell imports before any panel mounts. A token that somehow fails
  // to resolve degrades to the canvas default instead of a second
  // hard-coded palette, so the hex grep over src/ui stays empty.
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    bg: v('--bg'),
    bgRaise: v('--bg-raise'),
    bgSunken: v('--bg-sunken'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    accent: v('--accent'),
    accentDim: v('--accent-dim'),
    text: v('--text'),
    textDim: v('--text-dim'),
    textFaint: v('--text-faint'),
    ok: v('--ok'),
    warn: v('--warn'),
    bad: v('--bad'),
    mono: v('--font-mono') || 'ui-monospace, Menlo, Consolas, monospace',
    ui: v('--font-ui') || 'system-ui, sans-serif',
    radius: v('--radius'),
  };
}

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------
function txt(g, s, x, y, { font, color, align = 'left', baseline = 'alphabetic', spacing = 0 } = {}) {
  g.save();
  g.font = font;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = baseline;
  if (spacing && s.length > 1) {
    // manual letter-spacing for the mono readout feel
    let cx = x;
    const prevAlign = align;
    g.textAlign = 'left';
    const widths = [...s].map((ch) => g.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (s.length - 1);
    if (prevAlign === 'center') cx = x - total / 2;
    else if (prevAlign === 'right') cx = x - total;
    [...s].forEach((ch, i) => {
      g.fillText(ch, cx, y);
      cx += widths[i] + spacing;
    });
    g.restore();
    return;
  }
  g.fillText(s, x, y);
  g.restore();
}

function rule(g, x, y, w, color) {
  g.save();
  g.fillStyle = color;
  g.fillRect(x, y, w, 1);
  g.restore();
}

function panel(g, x, y, w, h, T) {
  g.save();
  g.fillStyle = T.bgRaise;
  g.strokeStyle = T.line;
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(x, y, w, h, 6);
  g.fill();
  g.stroke();
  g.restore();
}

function fmtOdo(km) {
  const v = Math.max(0, km);
  return v.toFixed(1);
}

function fmtDist(m) {
  if (m < 1000) return Math.round(m) + ' m';
  const km = m / 1000;
  return (km >= 10 ? km.toFixed(0) : km.toFixed(1)) + ' km';
}

function fmtClock(c) {
  return c.h + ':' + String(c.m).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Maneuver arrow pictograms, drawn with canvas paths (no icon fonts).
// ---------------------------------------------------------------------------
function arrowHead(g, x, y, angleDeg, size, color) {
  const a = ((angleDeg - 90) * Math.PI) / 180; // 0 deg = pointing up
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const px = -dy;
  const py = dx;
  g.save();
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x + dx * size, y + dy * size);
  g.lineTo(x - dx * size * 0.4 + px * size * 0.7, y - dy * size * 0.4 + py * size * 0.7);
  g.lineTo(x - dx * size * 0.4 - px * size * 0.7, y - dy * size * 0.4 - py * size * 0.7);
  g.closePath();
  g.fill();
  g.restore();
}

function polyArrow(g, pts, headAngle, color, lw) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke();
  g.restore();
  const [hx, hy] = pts[pts.length - 1];
  arrowHead(g, hx, hy, headAngle, lw * 1.9, color);
}

function drawManeuver(g, T, byte, cx, cy, s, color, dim) {
  const m = MANEUVERS[byte];
  const lw = s * 0.09;
  const dir = (deg, len) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [Math.cos(a) * len, Math.sin(a) * len];
  };
  if (!m) {
    txt(g, '?', cx, cy + s * 0.32, {
      font: `700 ${s * 0.9}px ${T.mono}`,
      color,
      align: 'center',
    });
    txt(g, '0x' + byte.toString(16).toUpperCase(), cx, cy + s * 0.62, {
      font: `${s * 0.16}px ${T.mono}`,
      color: dim,
      align: 'center',
    });
    return;
  }
  switch (m.kind) {
    case 'turn': {
      const elbow = [cx, cy + s * 0.1];
      const start = [cx, cy + s * 0.48];
      const [dx, dy] = dir(m.angle, s * 0.42);
      const end = [elbow[0] + dx, elbow[1] + dy];
      polyArrow(g, [start, elbow, end], m.angle, color, lw);
      break;
    }
    case 'uturn': {
      // U shape: up, arc over, back down with head.
      const r = s * 0.2;
      const top = cy - s * 0.32;
      const x0 = cx - m.dir * r;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - m.dir * r * 0.2, cy + s * 0.48);
      g.lineTo(cx - m.dir * r * 0.2, top + r);
      g.arc(cx + m.dir * r * 0.8, top + r, r, Math.PI * (m.dir < 0 ? 1 : 0), Math.PI * (m.dir < 0 ? 2 : 1), m.dir > 0);
      g.stroke();
      g.restore();
      arrowHead(g, cx + m.dir * r * 1.8, cy + s * 0.1, 180, lw * 1.9, color);
      void x0;
      break;
    }
    case 'rbt': {
      // Roundabout: entry from bottom, ring, exit arrow at the exit angle.
      const r = s * 0.3;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = lw * 0.9;
      g.beginPath();
      g.arc(cx, cy - s * 0.02, r, 0, Math.PI * 2);
      g.stroke();
      // entry stub from bottom to ring
      g.beginPath();
      g.moveTo(cx, cy + s * 0.48);
      g.lineTo(cx, cy - s * 0.02 + r);
      g.stroke();
      g.restore();
      const [dx, dy] = dir(m.angle, r * 1.7);
      const ex = cx + dx;
      const ey = cy - s * 0.02 + dy;
      polyArrow(g, [[cx, cy - s * 0.02], [ex, ey]], m.angle, color, lw * 0.9);
      break;
    }
    case 'fork': {
      // Two diverging paths: straight-ish main + branch at angle.
      polyArrow(g, [[cx, cy + s * 0.48], [cx, cy - s * 0.1], [cx, cy - s * 0.42]], 0, dim, lw * 0.8);
      const [dx, dy] = dir(m.angle, s * 0.4);
      polyArrow(
        g,
        [[cx, cy + s * 0.48], [cx, cy + s * 0.1], [cx + dx, cy + s * 0.1 + dy]],
        m.angle,
        color,
        lw,
      );
      break;
    }
    case 'noentry': {
      g.save();
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.beginPath();
      g.arc(cx, cy, s * 0.34, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - s * 0.24, cy + s * 0.24);
      g.lineTo(cx + s * 0.24, cy - s * 0.24);
      g.stroke();
      g.restore();
      break;
    }
    case 'arrived': {
      // Checkered flag.
      g.save();
      g.strokeStyle = color;
      g.lineWidth = lw * 0.7;
      g.beginPath();
      g.moveTo(cx - s * 0.28, cy + s * 0.48);
      g.lineTo(cx - s * 0.28, cy - s * 0.42);
      g.stroke();
      const fx = cx - s * 0.28;
      const fw = s * 0.5;
      const fh = s * 0.32;
      const cell = fw / 4;
      for (let rI = 0; rI < 2; rI++) {
        for (let cI = 0; cI < 4; cI++) {
          if ((rI + cI) % 2 === 0) {
            g.fillStyle = color;
            g.fillRect(fx + cI * cell, cy - s * 0.42 + rI * (fh / 2), cell, fh / 2);
          }
        }
      }
      g.strokeStyle = dim;
      g.lineWidth = 1;
      g.strokeRect(fx, cy - s * 0.42, fw, fh);
      g.restore();
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Shared widgets
// ---------------------------------------------------------------------------
function drawStatusBar(g, S, T, W, now, clock, engine) {
  const h = 30;
  g.save();
  g.fillStyle = T.bg;
  g.fillRect(0, 0, W, h);
  rule(g, 0, h - 1, W, T.line);
  const y = 20;
  const mono = T.mono;
  let x = 12;

  // Signal bars from the 0x4A frame, when fresh.
  if (S.mobile && now - S.mobile.at < MOBILE_FRESH_MS) {
    const bars = Math.max(0, Math.min(5, S.mobile.signal || 0));
    for (let i = 0; i < 5; i++) {
      const bh = 4 + i * 3;
      g.fillStyle = i < bars ? T.accent : T.lineStrong;
      g.fillRect(x + i * 7, y - bh + 2, 5, bh);
    }
    x += 5 * 7 + 8;
    // Phone battery from 0x4A byte 2 low nibble.
    txt(g, (S.mobile.batteryPct ?? 0) + '%', x, y, { font: `11px ${mono}`, color: T.textDim });
    x += 44;
    // Missed calls from 0x4A byte 10.
    if (S.mobile.missed > 0) {
      txt(g, 'MISS ' + S.mobile.missed, x, y, { font: `700 11px ${mono}`, color: T.warn });
      x += 58;
    }
    // Network type: raw byte shown, label mapping UNVERIFIED.
    txt(g, 'NET ' + S.mobile.network, x, y, { font: `11px ${mono}`, color: T.textDim });
  } else {
    txt(g, 'NO LINK', 12, y, { font: `700 11px ${mono}`, color: T.textDim });
  }

  // BLE link dot: lit when the engine reports a live transport.
  let linked = false;
  try {
    linked = !!(engine && typeof engine.isLinked === 'function' ? engine.isLinked() : engine && engine.linked);
  } catch { /* ignore */ }
  g.fillStyle = linked ? T.ok : T.textFaint;
  g.beginPath();
  g.arc(W - 118, 15, 4, 0, Math.PI * 2);
  g.fill();
  txt(g, linked ? 'LINK' : 'IDLE', W - 108, y, { font: `11px ${mono}`, color: T.textDim });

  // Clock, right aligned. Source: 0x4A when fresh, else phone time.
  txt(g, fmtClock(clock) + ' ' + clock.suffix, W - 12, y, {
    font: `700 14px ${mono}`,
    color: T.text,
    align: 'right',
  });
  g.restore();
}

function drawFuel(g, T, x, y, w, h, bars, maxBars, low, now, reduced) {
  // UNVERIFIED: segment count vs the real cluster gauge; engine normalizes
  // to bars/maxBars. Flash the whole gauge on low fuel (steady warn color
  // when reduced motion is preferred).
  const flashing = !reduced && low && Math.floor(now / 500) % 2 === 0;
  txt(g, 'FUEL', x, y - 6, { font: `10px ${T.ui}`, color: T.textDim });
  const n = Math.max(1, maxBars);
  const segW = (w - (n - 1) * 3) / n;
  for (let i = 0; i < n; i++) {
    const lit = i < Math.max(0, Math.min(n, bars));
    g.fillStyle = !lit ? T.line : flashing ? T.bad : i === 0 && low ? T.bad : T.accent;
    const sh = h * (0.55 + 0.45 * (i / n));
    g.fillRect(x + i * (segW + 3), y + (h - sh), segW, sh);
  }
  txt(g, 'E', x, y + h + 13, { font: `10px ${T.mono}`, color: T.textDim });
  txt(g, 'F', x + w - 7, y + h + 13, { font: `10px ${T.mono}`, color: T.textDim });
  if (low) {
    txt(g, 'LOW FUEL', x + w / 2, y + h + 30, {
      font: `700 12px ${T.mono}`,
      color: flashing ? T.bad : T.warn,
      align: 'center',
    });
  }
}

function drawTemp(g, T, x, y, w, tempC) {
  // UNVERIFIED thresholds: the cluster temp gauge scale is not documented.
  txt(g, 'ENG', x, y - 6, { font: `10px ${T.ui}`, color: T.textDim });
  if (!Number.isFinite(tempC)) {
    txt(g, '-- C', x, y + 12, { font: `700 14px ${T.mono}`, color: T.textDim });
    return;
  }
  const frac = Math.max(0, Math.min(1, (tempC - 40) / 90));
  g.fillStyle = T.line;
  g.fillRect(x, y, w, 8);
  g.fillStyle = tempC > 110 ? T.bad : tempC > 95 ? T.warn : T.accent;
  g.fillRect(x, y, w * frac, 8);
  txt(g, Math.round(tempC) + ' C', x, y + 24, { font: `700 14px ${T.mono}`, color: T.text });
}

function drawPictogramBadge(g, T, x, y, name) {
  // 0x50 carries a free-form icon *name*, not a byte; the cluster glyph set
  // is UNVERIFIED, so the name is shown as a badge. Keyword-matched names
  // get a matching arrow; everything else is text only.
  const w = 190;
  const h = 40;
  panel(g, x - w / 2, y, w, h, T);
  let drawn = false;
  const low = name.toLowerCase();
  const m = low.includes('u-turn') || low.includes('uturn')
    ? { kind: 'uturn', dir: low.includes('right') ? 1 : -1, label: '' }
    : low.includes('roundabout') || low.includes('rbt')
      ? { kind: 'rbt', angle: 0, label: '' }
      : low.includes('left') && low.includes('right')
        ? { kind: 'fork', angle: 0, label: '' }
        : low.includes('left')
          ? { kind: 'turn', angle: -90, label: '' }
          : low.includes('right')
            ? { kind: 'turn', angle: 90, label: '' }
            : low.includes('straight') || low.includes('ahead')
              ? { kind: 'turn', angle: 0, label: '' }
              : null;
  if (m) {
    drawManeuver(g, T, m.kind === 'turn' ? (m.angle === -90 ? 0 : m.angle === 90 ? 3 : 7)
      : m.kind === 'uturn' ? (m.dir < 0 ? 6 : 41)
      : m.kind === 'rbt' ? 68 : 21, x - w / 2 + 26, y + h / 2, 22, T.accent, T.accentDim);
    drawn = true;
  }
  txt(g, name.slice(0, 17), x + (drawn ? 12 : -w / 2 + 12), y + 25, {
    font: `11px ${T.mono}`,
    color: T.textDim,
    align: drawn ? 'center' : 'left',
  });
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function drawRide(g, args) {
  const { S, T, now, engine, W, H, clock, reduced } = args;
  const st = readEngineState(engine);
  const mono = T.mono;

  g.fillStyle = T.bgSunken;
  g.fillRect(0, 0, W, H);

  // Big speed, mono, centered in the clear zone between the data columns.
  // Auto-fits: three-digit speeds shrink instead of bleeding into the
  // ODO/trip column (x < 150) or the fuel/temp column (x > 325).
  const speed = Math.max(0, Math.round(st.speedKmh));
  const SPEED_CX = 237;
  const SPEED_MAXW = 175;
  let speedPx = 130;
  g.save();
  g.font = `700 ${speedPx}px ${mono}`;
  const speedW = g.measureText(String(speed)).width + 4; // + letter spacing
  if (speedW > SPEED_MAXW) speedPx = Math.max(44, Math.floor((speedPx * SPEED_MAXW) / speedW));
  g.restore();
  txt(g, String(speed), SPEED_CX, 178, {
    font: `700 ${speedPx}px ${mono}`,
    color: st.vehicleOff ? T.textFaint : T.text,
    align: 'center',
    spacing: 2,
  });
  txt(g, 'km/h', SPEED_CX, 208, { font: `12px ${mono}`, color: T.textDim, align: 'center', spacing: 6 });

  // Left data column: odo, trips.
  let ly = 78;
  const row = (label, value) => {
    txt(g, label, 18, ly, { font: `10px ${T.ui}`, color: T.textDim, spacing: 2 });
    txt(g, value, 18, ly + 26, { font: `700 22px ${mono}`, color: T.text });
    ly += 56;
  };
  row('ODO', fmtOdo(st.odoKm) + ' km');
  if (Number.isFinite(st.tripAKm)) row('TRIP A', fmtOdo(st.tripAKm) + ' km');
  else if (Number.isFinite(st.tripKm)) row('TRIP', fmtOdo(st.tripKm) + ' km');
  if (Number.isFinite(st.tripBKm)) row('TRIP B', fmtOdo(st.tripBKm) + ' km');

  // Right column: fuel, temp, ignition.
  const rx = 330;
  const low = st.reserve || st.fuelBars <= 1;
  drawFuel(g, T, rx, 74, 120, 44, st.fuelBars, st.fuelBarsMax, low, now, reduced);
  drawTemp(g, T, rx, 168, 120, st.engineTempC);

  // Ignition / gear pill.
  const ignOn = st.ignitionOn && !st.vehicleOff;
  g.save();
  g.fillStyle = ignOn ? T.accent : T.line;
  g.beginPath();
  g.roundRect(rx, 208, 120, 30, 15);
  g.fill();
  txt(g, st.vehicleOff ? 'OFF' : ignOn ? 'IGN ON' : 'IGN OFF', rx + 60, 229, {
    font: `700 13px ${mono}`,
    color: ignOn ? T.bg : T.textDim,
    align: 'center',
    spacing: 1,
  });
  g.restore();
  // Malfunction indicator lamp: steady amber while the engine has latched
  // DTCs (injected from the Controls deck or the Fault injection scenario).
  // Drawn ghosted when clear so the lamp position never jumps around.
  const milOn = !!st.milOn;
  g.save();
  g.beginPath();
  g.roundRect(rx, 246, 120, 26, 13);
  if (milOn) {
    g.fillStyle = T.warn;
    g.fill();
  } else {
    g.strokeStyle = T.line;
    g.lineWidth = 1.5;
    g.stroke();
  }
  txt(g, milOn && st.dtcCount > 1 ? 'MIL x' + st.dtcCount : 'MIL', rx + 60, 264, {
    font: `700 12px ${mono}`,
    color: milOn ? T.bg : T.textFaint,
    align: 'center',
    spacing: 2,
  });
  g.restore();
  if (st.gear) {
    txt(g, 'GEAR ' + String(st.gear).toUpperCase(), rx + 60, 288, {
      font: `700 15px ${mono}`,
      color: T.text,
      align: 'center',
    });
  }
  if (st.powerMode || st.ecoMode) {
    txt(g, st.powerMode ? 'POWER' : 'ECO', SPEED_CX, 258, {
      font: `700 13px ${mono}`,
      color: T.accent,
      align: 'center',
      spacing: 3,
    });
  }

  // Pictogram cue badge (0x50) as an overlay, bottom center.
  if (S.picto && now - S.picto.at < PICTO_MS && S.picto.name) {
    drawPictogramBadge(g, T, W / 2, H - 52, S.picto.name);
  }

  drawStatusBar(g, S, T, W, now, clock, engine);
}

function drawNav(g, args, stale) {
  const { S, T, now, W, H, clock, engine, reduced } = args;
  const n = S.nav;
  const m = MANEUVERS[n.pictogram];
  g.fillStyle = T.bgSunken;
  g.fillRect(0, 0, W, H);

  txt(g, 'NAVIGATION', 18, 58, { font: `700 12px ${T.ui}`, color: T.textDim, spacing: 4 });

  // Arrow pictogram, canvas-drawn from the maneuver byte.
  drawManeuver(g, T, n.pictogram, 105, 165, 120, stale ? T.textFaint : T.accent, T.accentDim);
  txt(g, m ? m.label.toUpperCase() : 'UNKNOWN 0x' + n.pictogram.toString(16).toUpperCase(),
    105, 252, {
      font: `700 13px ${T.mono}`,
      color: stale ? T.textFaint : T.text,
      align: 'center',
      spacing: 1,
    });

  // Distance to maneuver + road name, exactly as the frames describe.
  txt(g, fmtDist(n.distanceM), 300, 150, {
    font: `700 64px ${T.mono}`,
    color: stale ? T.textFaint : T.text,
    align: 'center',
  });
  const road = (S.navText || '').slice(0, 34);
  txt(g, road || '...', 300, 190, {
    font: `16px ${T.mono}`,
    color: stale ? T.textFaint : T.textDim,
    align: 'center',
  });

  // ETA + trip remaining from the control frame.
  txt(g, n.etaMin > 0 ? 'ETA ' + n.etaMin + ' MIN' : 'ETA --', 300, 226, {
    font: `12px ${T.mono}`,
    color: T.textDim,
    align: 'center',
    spacing: 1,
  });
  txt(g, n.remainingM > 0 ? 'TRIP LEFT ' + fmtDist(n.remainingM) : 'TRIP LEFT --', 300, 248, {
    font: `12px ${T.mono}`,
    color: T.textDim,
    align: 'center',
    spacing: 1,
  });

  if (stale) {
    const on = reduced || Math.floor(now / 600) % 2 === 0;
    txt(g, 'HUD LINK LOST', W / 2, 278, {
      font: `700 14px ${T.mono}`,
      color: on ? T.warn : T.textFaint,
      align: 'center',
      spacing: 3,
    });
  }
  drawStatusBar(g, S, T, W, now, clock, engine);
}

function drawCall(g, args) {
  const { S, T, now, W, H, clock, engine, reduced } = args;
  const c = S.call;
  g.fillStyle = T.bgSunken;
  g.fillRect(0, 0, W, H);

  const on = reduced || Math.floor(now / 700) % 2 === 0;
  txt(g, 'INCOMING CALL', W / 2, 96, {
    font: `700 20px ${T.ui}`,
    color: on ? T.accent : T.accentDim,
    align: 'center',
    spacing: 6,
  });

  // Phone glyph, canvas-drawn (no icon fonts).
  g.save();
  g.strokeStyle = T.accent;
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(W / 2, 150, 26, Math.PI * 0.6, Math.PI * 1.75);
  g.stroke();
  g.beginPath();
  g.moveTo(W / 2 - 14, 128);
  g.lineTo(W / 2 - 22, 120);
  g.moveTo(W / 2 + 14, 128);
  g.lineTo(W / 2 + 22, 120);
  g.stroke();
  g.restore();

  txt(g, (c.name || 'UNKNOWN').slice(0, 24), W / 2, 208, {
    font: `700 26px ${T.mono}`,
    color: T.text,
    align: 'center',
  });
  txt(g, (c.number || '').slice(0, 24), W / 2, 238, {
    font: `18px ${T.mono}`,
    color: T.textDim,
    align: 'center',
  });
  // UNVERIFIED: the cluster button mapping for answer/reject is not
  // documented; these are hints only.
  txt(g, 'TAP: ANSWER      HOLD: REJECT', W / 2, 272, {
    font: `11px ${T.mono}`,
    color: T.textFaint,
    align: 'center',
    spacing: 2,
  });
  drawStatusBar(g, S, T, W, now, clock, engine);
}

function drawMessage(g, args) {
  const { S, T, now, W, H, clock, engine } = args;
  g.fillStyle = T.bgSunken;
  g.fillRect(0, 0, W, H);
  txt(g, 'MESSAGE', 18, 58, { font: `700 12px ${T.ui}`, color: T.textDim, spacing: 4 });

  // 2x17 char rows, cycling pages every TEXT_CYCLE_MS.
  const pages1 = paginate(S.msg.row1);
  const pages2 = paginate(S.msg.row2);
  const nPages = Math.max(pages1.length, pages2.length, 1);
  const page = Math.floor((now - S.msg.at) / TEXT_CYCLE_MS) % nPages;
  txt(g, pages1[page] || '', W / 2, 140, {
    font: `700 30px ${T.mono}`,
    color: T.text,
    align: 'center',
    spacing: 1,
  });
  txt(g, pages2[page] || '', W / 2, 190, {
    font: `700 30px ${T.mono}`,
    color: T.textDim,
    align: 'center',
    spacing: 1,
  });
  if (nPages > 1) {
    for (let i = 0; i < nPages; i++) {
      g.fillStyle = i === page ? T.accent : T.lineStrong;
      g.beginPath();
      g.arc(W / 2 - (nPages - 1) * 10 + i * 20, 232, 4, 0, Math.PI * 2);
      g.fill();
    }
  }
  txt(g, String(S.msg.row1.length + S.msg.row2.length) + ' CHARS', W / 2, 268, {
    font: `10px ${T.mono}`,
    color: T.textDim,
    align: 'center',
    spacing: 2,
  });
  drawStatusBar(g, S, T, W, now, clock, engine);
}

function paginate(s) {
  if (!s) return [''];
  const out = [];
  for (let i = 0; i < s.length; i += 17) out.push(s.slice(i, i + 17));
  return out;
}

function drawMedia(g, args) {
  const { S, T, now, W, H, clock, engine } = args;
  const md = S.media;
  g.fillStyle = T.bgSunken;
  g.fillRect(0, 0, W, H);
  txt(g, 'MEDIA', 18, 58, { font: `700 12px ${T.ui}`, color: T.textDim, spacing: 4 });

  // Note: the 0x61/0x62/0x65 -> title/artist/album mapping is UNVERIFIED
  // (field mapping best-effort per jupiter_text.dart); labels shown anyway.
  const rows = [
    ['TITLE', md.title],
    ['ARTIST', md.artist],
    ['ALBUM', md.album],
  ];
  let y = 116;
  for (const [label, value] of rows) {
    txt(g, label, 40, y, { font: `10px ${T.ui}`, color: T.textDim, spacing: 3 });
    txt(g, (value || '--').slice(0, 30), 40, y + 32, {
      font: `700 24px ${T.mono}`,
      color: value ? T.text : T.textFaint,
    });
    y += 62;
  }
  drawStatusBar(g, S, T, W, now, clock, engine);
}

function drawScreen(g, screen, args) {
  const { W, H } = args;
  g.save();
  g.clearRect(0, 0, W, H);
  switch (screen) {
    case 'call':
      drawCall(g, args);
      break;
    case 'nav':
      drawNav(g, args, false);
      break;
    case 'nav-stale':
      drawNav(g, args, true);
      break;
    case 'media':
      drawMedia(g, args);
      break;
    case 'message':
      drawMessage(g, args);
      break;
    case 'ride':
    default:
      drawRide(g, args);
      break;
  }
  g.restore();
}
