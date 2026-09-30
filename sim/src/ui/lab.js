/* Telemetry Lab: live frame-inspector panel for the Scoot scooter simulator.
 *
 * Mirrors what the Scoot app's SessionDiagnostics shows, at the byte level,
 * so frame flow between the sim (virtual cluster) and the app can be
 * verified without touching the main pipeline.
 *
 * Wiring contract: mount(rootEl, ctx) with ctx = { engine, transport, bus }.
 * - engine 'frame' events  : frames emitted BY the sim (cluster -> phone).
 *                            Shown as RX (inbound to the app).
 * - transport 'frame' events: frames arriving FROM the app (phone -> cluster).
 *                            Shown as TX (outbound from the app).
 * Transport extras used when present: sendFrame() for the fault injector,
 * 'peer' / 'status' events and isConnected() for link health.
 * The lab only subscribes. It never modifies, drops, reorders, or delays
 * frames. The corrupt-frame injector is the one exception and is an
 * explicit, labeled test fault.
 *
 * Frame truth (never invented): byte positions come from
 *   lib/vehicles/tvs_jupiter/jupiter_mobile_data.dart (0x4A)
 *   lib/vehicles/tvs_jupiter/jupiter_text.dart        (0x4C/0x63/0x52/0x43/0x50/0x61/0x62/0x65/0x22)
 *   lib/vehicles/tvs_jupiter/jupiter_navigation.dart  (0x5A 0x4E nav control)
 *   lib/vehicles/tvs_jupiter/jupiter_checksum.dart    (checksum formula)
 * Checksum flag is informational only, like the app's diagnostics: the real
 * cluster does not reliably compute the phone-side formula inbound.
 *
 * Decoder note: sim/src/engine/frames.js (W3) exposes decodeOutbound and
 * decodeText but no inbound decoders, so the lab keeps its own minimal
 * field decodes for every row, taken straight from the Dart sources, so
 * inbound and outbound decode the same way. One deliberate difference:
 * W3's decodeOutbound flags the 0x5A 0x4E nav-control lead byte as
 * bad-start; the lab accepts a 0x5A lead on outbound frames because
 * buildNavControlFrame in jupiter_navigation.dart emits packet[0] = 0x5A.
 *
 * No dependencies. Vanilla DOM. Styles are injected so the panel is
 * self-contained; every color resolves through sim/src/styles/tokens.css
 * (the volt-lime accent is var(--accent), referenced via --lab-volt).
 */

const FRAME_SIZE = 20;
const START_PHONE = 0x5b; // phone -> cluster
const START_CLUSTER = 0x5a; // cluster -> phone
const START_CLUSTER_ALT = 0x9b; // alternate inbound start, accepted by the app
const END_BYTE = 0xff;
const CHECKSUM_INDEX = 18;

/* Frame IDs tracked by the lab, grouped by direction from the app's view. */
const ROWS = [
  { id: 0x10, name: 'TELEMETRY PRIMARY', dir: 'in' },
  { id: 0x11, name: 'TELEMETRY SERVICE', dir: 'in' },
  { id: 0x18, name: 'TELEMETRY ENGINE', dir: 'in' },
  { id: 0x19, name: 'TELEMETRY ECONOMY', dir: 'in' },
  { id: 0x6b, name: 'MUSIC CMD', dir: 'in' },
  { id: 0x4a, name: 'MOBILE DATA', dir: 'out' },
  { id: 0x4c, name: 'TEXT ROW 1', dir: 'out' },
  { id: 0x63, name: 'TEXT ROW 2', dir: 'out' },
  { id: 0x52, name: 'REGISTRATION', dir: 'out' },
  { id: 0x5a, name: 'NAV LEAD (byte1 slot)', dir: 'out' },
  { id: 0x4e, name: 'NAV CONTROL (lead 0x5A)', dir: 'out' },
  { id: 0x4f, name: 'NAV TEXT', dir: 'out' },
  { id: 0x43, name: 'CALLER INFO', dir: 'out' },
  { id: 0x50, name: 'PICTOGRAM', dir: 'out' },
  { id: 0x61, name: 'MEDIA TITLE*', dir: 'out' },
  { id: 0x62, name: 'MEDIA ARTIST*', dir: 'out' },
  { id: 0x65, name: 'MEDIA ALBUM*', dir: 'out' },
  { id: 0x22, name: 'USER ID', dir: 'out' },
];
/* * title/artist/album mapping is UNVERIFIED in the Dart sources. */

const hex2 = (b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase();
const idHex = (id) => '0x' + id.toString(16).padStart(2, '0').toUpperCase();

function jupiterChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < 18; i++) sum += bytes[i] & 0xff;
  return 255 - (sum % 256);
}
function checksumOk(frame) {
  if (!frame || frame.length !== FRAME_SIZE) return null;
  return (frame[CHECKSUM_INDEX] & 0xff) === jupiterChecksum(frame);
}

/* Normalize whatever the emitter hands us into a Uint8Array (or null). */
function toBytes(ev) {
  if (!ev) return null;
  if (ev instanceof Uint8Array) return ev;
  if (Array.isArray(ev)) return Uint8Array.from(ev.map((b) => b & 0xff));
  if (ev instanceof ArrayBuffer) return new Uint8Array(ev);
  for (const k of ['bytes', 'frame', 'data', 'payload', 'raw']) {
    const v = ev[k];
    if (v instanceof Uint8Array) return v;
    if (Array.isArray(v)) return Uint8Array.from(v.map((b) => b & 0xff));
  }
  return null;
}

function subscribe(emitter, event, fn) {
  if (!emitter) return () => {};
  try {
    if (typeof emitter.on === 'function') {
      emitter.on(event, fn);
      return () => { try { emitter.off && emitter.off(event, fn); } catch (_) {} };
    }
    if (typeof emitter.addEventListener === 'function') {
      const wrap = (e) => fn(e && e.detail !== undefined ? e.detail : e);
      emitter.addEventListener(event, wrap);
      return () => { try { emitter.removeEventListener(event, wrap); } catch (_) {} };
    }
    if (typeof emitter.subscribe === 'function') {
      const sub = emitter.subscribe(event, fn);
      return () => { try { (sub && sub.unsubscribe ? sub.unsubscribe() : null); } catch (_) {} };
    }
  } catch (_) { /* unsupported emitter, stay silent */ }
  return () => {};
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' +
    p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
}
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}
function decodeText(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end--;
  try {
    return new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.slice(0, end)).replace(/[\x00-\x1F\x7F]/g, '');
  } catch (_) {
    return Array.from(bytes.slice(0, end), (b) =>
      (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '?').join('');
  }
}

/* ------------------------------------------------------------------ */
/* Decoders: minimal, field positions copied from the Dart sources.     */
/* ------------------------------------------------------------------ */

function decodePinned(id, f) {
  const rows = [];
  const R = (name, pos, value) => rows.push({ name, pos, value });
  const u16 = (hi, lo) => ((f[hi] << 8) | f[lo]) >>> 0;
  const u24 = (a, b, c) => ((f[a] << 16) | (f[b] << 8) | f[c]) >>> 0;
  switch (id) {
    case 0x10: {
      const ig = f[12];
      const igLabel = ig === 128 ? 'IGNITION ON' : ig === 64 ? 'VEHICLE OFF' :
        ig === 1 ? 'CALL ACCEPT' : ig === 2 ? 'CALL REJECT' :
        ig === 3 ? 'REJECT+SMS' : ig === 4 ? 'VOICE ASSIST' : 'raw';
      R('speed (PROVISIONAL)', 'b2', f[2] + ' km/h');
      R('odometer', 'b3-5 BE', (u24(3, 4, 5) / 10).toFixed(1) + ' km');
      R('fuel byte raw (110)', 'b6', '0x' + hex2(f[6]) + ' level=' + f[6] +
        ' reserve=' + ((f[6] & 0xf0) !== 0));
      R('avg speed', 'b7', f[7] + ' km/h');
      R('eco/power', 'b8', (f[8] === 1 ? 'POWER' : 'ECO') + ' (raw ' + f[8] + ')');
      R('top speed', 'b9', f[9] + ' km/h');
      R('throttle', 'b10', String(f[10]));
      R('backlight', 'b11', '0x' + hex2(f[11]));
      R('ignition / call switch', 'b12', '0x' + hex2(ig) + ' ' + igLabel);
      R('0-60 raw (not usable)', 'b13', String(f[13]));
      R('trip meter', 'b14-16 BE', (u24(14, 15, 16) / 10).toFixed(1) + ' km');
      R('engine rpm', 'b17-18 BE', String(u16(17, 18)));
      break;
    }
    case 0x11: {
      R('fuel sensor failure', 'b2', '0x' + hex2(f[2]));
      R('vehicle state 1', 'b3', '0x' + hex2(f[3]));
      R('service reminder', 'b4', f[4] !== 0 ? 'DUE' : 'clear');
      R('ISS byte', 'b6', '0x' + hex2(f[6]));
      R('speedo SW version', 'b7', String(f[7]));
      R('MIL blink code', 'b8', String(f[8]));
      R('vehicle model raw', 'b9', String(f[9]));
      R('diagnostics', 'b10', '0x' + hex2(f[10]) +
        ((f[10] & 0x04) ? ' MIL ON' : ' MIL off'));
      R('ISG blink code', 'b11', String(f[11]));
      R('turn indicator', 'b12', '0x' + hex2(f[12]));
      R('connector status', 'b13', '0x' + hex2(f[13]));
      R('cluster theme', 'b14', String(f[14]));
      R('screenshot trigger', 'b17', String(f[17]));
      break;
    }
    case 0x18: {
      R('engine load', 'b2', String(f[2]));
      R('fuel inj time', 'b3-4 BE', String(u16(3, 4)));
      R('manifold air press', 'b5', String(f[5]));
      R('baro press (U714)', 'b6', String(f[6]));
      R('intake air temp', 'b7', String(f[7]));
      R('engine temp', 'b8', String(f[8]));
      R('barometric press', 'b9-10 BE', String(u16(9, 10)));
      R('battery', 'b11', (f[11] * 0.1).toFixed(2) + ' V (raw ' + f[11] + ')');
      R('engine run time', 'b12-13 BE', String(u16(12, 13)));
      R('distance traveled', 'b14-15 BE', String(u16(14, 15)));
      R('fuel inj volume', 'b16-17 BE', String(u16(16, 17)));
      break;
    }
    case 0x19: {
      R('ISS duration raw', 'b2-4 24b', String(u24(2, 3, 4)));
      R('OTA status', 'b5', '0x' + hex2(f[5]));
      R('avg economy', 'b8', f[8] + ' km/L');
      R('instant economy', 'b9', f[9] + ' km/L');
      R('DTE', 'b11-12 BE', u16(11, 12) + ' km');
      R('ISS count raw', 'b15-17 24b', String(u24(15, 16, 17)));
      break;
    }
    case 0x6b: {
      const cmds = ['play', 'pause', 'toggle', 'next', 'previous', 'vol+', 'vol-'];
      const c = f[2];
      R('music command', 'b2', c <= 6 ? cmds[c] + ' (' + c + ')' : 'UNKNOWN (' + c + ')');
      break;
    }
    case 0x4a: {
      const hh = f[6], mm = String(f[7]).padStart(2, '0'), ss = String(f[8]).padStart(2, '0');
      R('signal / battery', 'b2', ((f[2] >> 4) & 15) + ' bars / ' + ((f[2] & 15) * 25) + '%');
      R('overspeed limit', 'b3', f[3] + ' km/h');
      R('ambient temp', 'b4', (f[4] - 40) + ' C');
      R('clock', 'b6-9', hh + ':' + mm + ':' + ss + (f[9] === 1 ? ' PM' : ' AM'));
      R('missed calls', 'b10', String(f[10]));
      R('network type', 'b11', String(f[11]));
      R('date', 'b12-14', f[12] + '/' + f[13] + '/20' + String(f[14]).padStart(2, '0'));
      R('find-me', 'b17', f[17] === 1 ? 'ACTIVE' : 'off');
      break;
    }
    case 0x4c:
    case 0x63:
    case 0x52: {
      const label = id === 0x4c ? 'row 1' : id === 0x63 ? 'row 2' : 'rider name';
      R('text (' + label + ')', 'b2-18', '"' + decodeText(f.slice(2, 19)) + '"');
      break;
    }
    case 0x43: {
      const sub = f[2];
      const subLabel = sub === 1 ? 'national number' : sub === 2 ? 'contact name' :
        sub === 3 ? 'country code' : 'unknown sub-id';
      R('sub-id', 'b2', '0x' + hex2(sub) + ' ' + subLabel);
      R('text', 'b3-18', '"' + decodeText(f.slice(3, 19)) + '"');
      break;
    }
    case 0x50: {
      R('pictogram name', 'b2-18', '"' + decodeText(f.slice(2, 19)) + '"');
      R('note', '-', 'dex tail is FF 00, not a lone FF');
      break;
    }
    case 0x61:
    case 0x62:
    case 0x65: {
      const field = id === 0x61 ? 'title*' : id === 0x62 ? 'artist*' : 'album*';
      R('media ' + field, 'b2-17', '"' + decodeText(f.slice(2, 18)) + '"');
      R('note', '-', '* id-to-field mapping UNVERIFIED');
      break;
    }
    case 0x22: {
      let i = 2;
      while (i < 18 && f[i] === 0x00) i++;
      const val = Array.from(f.slice(i, 19)).reduce((a, b) => a * 256 + b, 0);
      R('user id', 'b2-18 BE', String(val));
      break;
    }
    case 0x4e: {
      R('distance', 'b2-3 BE', u16(2, 3) + ' m');
      R('ETA', 'b4-5 BE', u16(4, 5) + ' min');
      R('remaining trip', 'b6-8 24b', u24(6, 7, 8) + ' m');
      R('pictogram', 'b9', String(f[9]));
      R('row count', 'b10', String(f[10]));
      R('nav status', 'b11', '0x' + hex2(f[11]));
      R('note', '-', 'lead bytes are 0x5A 0x4E, not 0x5B');
      break;
    }
    case 0x4f: {
      R('text (nav)', 'b2-18', '"' + decodeText(f.slice(2, 19)) + '"');
      break;
    }
    default:
      R('note', '-', 'no decoder for this ID; hex view is the source of truth');
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Styles: every color resolves through sim/src/styles/tokens.css. This   */
/* panel keeps its own --lab-* aliases only as shorthand; the palette     */
/* itself (accent, surfaces, text, status) is the locked cockpit set.     */
/* ------------------------------------------------------------------ */

const CSS = `
.lab{--lab-volt:var(--accent);--lab-bg:var(--bg-sunken);--lab-panel:var(--bg-raise);
--lab-line:var(--line);--lab-text:var(--text);--lab-dim:var(--text-dim);--lab-bad:var(--bad);--lab-warn:var(--warn);
background:var(--lab-bg);color:var(--lab-text);
font-family:var(--font-mono);
font-size:12px;line-height:1.45;border:1px solid var(--lab-line);border-radius:var(--radius);overflow:hidden}
.lab *{box-sizing:border-box}
.lab-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;
padding:10px 12px;border-bottom:1px solid var(--lab-line);background:var(--lab-panel)}
.lab-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--lab-dim)}
.lab-dot{width:8px;height:8px;border-radius:50%;background:var(--lab-volt)}
.lab.paused .lab-dot{background:var(--lab-warn)}
@media (prefers-reduced-motion:no-preference){.lab.live .lab-dot{animation:labpulse 1.6s infinite}}
@keyframes labpulse{0%,100%{opacity:1}50%{opacity:.35}}
.lab-uptime{color:var(--lab-dim);font-size:11px}
.lab-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.lab-btn{background:transparent;border:1px solid var(--lab-line);color:var(--lab-text);
font:inherit;font-size:11px;letter-spacing:.06em;padding:6px 10px;min-height:32px;border-radius:var(--radius);cursor:pointer}
.lab-btn:hover{border-color:var(--lab-volt);color:var(--lab-volt)}
.lab-btn:active{transform:translateY(1px)}
.lab-btn.fault{border-color:var(--lab-warn);color:var(--lab-warn)}
.lab-btn.fault:hover{background:color-mix(in srgb,var(--lab-warn) 8%,transparent)}
.lab-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
@media (max-width:860px){.lab-grid{grid-template-columns:1fr}}
.lab-sec{padding:10px 12px;border-bottom:1px solid var(--lab-line)}
.lab-sec h3{margin:0 0 8px;font-size:10px;letter-spacing:.14em;color:var(--lab-dim);font-weight:700}
.lab-tablewrap{overflow-x:auto;border-right:1px solid var(--lab-line)}
@media (max-width:860px){.lab-tablewrap{border-right:0}}
.lab table{width:100%;border-collapse:collapse;font-size:11px;min-width:560px}
.lab th{text-align:left;font-size:10px;letter-spacing:.1em;color:var(--lab-dim);font-weight:700;
padding:6px 8px;border-bottom:1px solid var(--lab-line);white-space:nowrap}
.lab td{padding:5px 8px;border-bottom:1px solid var(--lab-line);white-space:nowrap}
.lab tbody tr{cursor:pointer}
.lab tbody tr:hover td{background:color-mix(in srgb,var(--lab-volt) 4%,transparent)}
.lab tbody tr.pinned td{background:color-mix(in srgb,var(--lab-volt) 7%,transparent)}
.lab tbody tr.pinned td:first-child{box-shadow:inset 2px 0 0 var(--lab-volt)}
.lab tr.grp td{background:var(--lab-panel);color:var(--lab-dim);font-size:10px;letter-spacing:.14em;
cursor:default;padding:6px 8px}
.lab .num{text-align:right;font-variant-numeric:tabular-nums}
.lab .ck-ok{color:var(--lab-volt)}.lab .ck-bad{color:var(--lab-bad);font-weight:700}
.lab .ck-na{color:var(--lab-dim)}
.lab-health{display:grid;grid-template-columns:1fr 1fr;gap:0}
.lab-hstat{padding:6px 0;border-bottom:1px solid var(--lab-line);display:flex;
justify-content:space-between;gap:8px}
.lab-hstat .k{color:var(--lab-dim);font-size:10px;letter-spacing:.08em}
.lab-hstat .v{font-variant-numeric:tabular-nums}
.lab-hstat .v.ok{color:var(--lab-volt)}.lab-hstat .v.bad{color:var(--lab-bad);font-weight:700}
.lab-hstat .v.warn{color:var(--lab-warn)}
.lab-hex{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin:4px 0 8px}
@media (max-width:520px){.lab-hex{grid-template-columns:repeat(5,1fr)}}
.lab-byte{border:1px solid var(--lab-line);border-radius:4px;padding:4px 2px;text-align:center}
.lab-byte .i{display:block;font-size:9px;color:var(--lab-dim)}
.lab-byte .b{font-size:12px;font-variant-numeric:tabular-nums}
.lab-byte.start{border-color:var(--lab-volt)}
.lab-byte.start .i{color:var(--lab-volt)}
.lab-byte.end{border-color:var(--lab-dim)}
.lab-byte.cksum-ok{border-color:var(--lab-volt)}
.lab-byte.cksum-bad{border-color:var(--lab-bad)}
.lab-byte.cksum-bad .b{color:var(--lab-bad);font-weight:700}
.lab-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;color:var(--lab-dim);margin-bottom:8px}
.lab-legend b{font-weight:700}
.lab-legend .sw{color:var(--lab-volt)}.lab-legend .ew{color:var(--lab-dim)}
.lab-legend .cw-ok{color:var(--lab-volt)}.lab-legend .cw-bad{color:var(--lab-bad)}
.lab-decode{width:100%;border-collapse:collapse;font-size:11px}
.lab-decode td{padding:4px 6px;border-bottom:1px solid var(--lab-line);vertical-align:top}
.lab-decode td:first-child{color:var(--lab-dim);white-space:nowrap}
.lab-decode td:nth-child(2){color:var(--lab-dim);white-space:nowrap}
.lab-decode td:last-child{text-align:right;font-variant-numeric:tabular-nums;word-break:break-word}
.lab-pinhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}
.lab-pinhead .t{font-weight:700;letter-spacing:.06em}
.lab-pinhead .s{font-size:10px;color:var(--lab-dim)}
.lab-empty{color:var(--lab-dim);font-size:11px;padding:12px 0}
.lab-log{font-size:10px;color:var(--lab-dim);padding:8px 12px;border-bottom:1px solid var(--lab-line);
min-height:30px}
.lab-log .warn{color:var(--lab-warn)}
.lab-note{padding:8px 12px;font-size:10px;color:var(--lab-dim)}
.lab-note b{color:var(--lab-text)}
`;

export function mount(rootEl, ctx = {}) {
  const { engine = null, transport = null, bus = null } = ctx;
  const t0 = Date.now();

  /* Per-ID state. */
  const rows = new Map();
  for (const r of ROWS) {
    rows.set(r.dir + ':' + r.id, {
      ...r, rx: 0, tx: 0, lastSeen: 0, lastFrame: null, lastCk: null, stamps: [],
    });
  }
  const health = {
    unknown: 0, corrupt: 0, faults: 0,
    rxStamps: [], txStamps: [],
  };
  let paused = false;
  let pinnedKey = null;
  let lastRenderedFrame = null;
  let lastLog = 'lab ready. observing only.';

  /* ---------------- frame intake (observe only) ---------------- */

  function validStart(byte0, dir) {
    if (dir === 'in') return byte0 === START_CLUSTER || byte0 === START_CLUSTER_ALT || byte0 === START_PHONE;
    return byte0 === START_PHONE || byte0 === START_CLUSTER; // 0x5A lead: nav control / vehicle control
  }

  function intake(bytes, dir) {
    const now = Date.now();
    if (!bytes || bytes.length === 0) { health.corrupt++; return; }
    const id = bytes[1] & 0xff;
    const key = dir + ':' + id;
    const row = rows.get(key);
    if (!row) { health.unknown++; }
    const lenOk = bytes.length === FRAME_SIZE;
    const startOk = validStart(bytes[0] & 0xff, dir);
    const endOk = lenOk && (bytes[FRAME_SIZE - 1] & 0xff) === END_BYTE;
    if (!lenOk || !startOk || !endOk) health.corrupt++;
    const ck = checksumOk(bytes.length === FRAME_SIZE ? bytes : null);
    if (row) {
      if (dir === 'in') { row.rx++; } else { row.tx++; }
      row.lastSeen = now;
      row.lastFrame = bytes.slice(0, FRAME_SIZE);
      row.lastCk = ck;
      row.stamps.push(now);
      if (row.stamps.length > 120) row.stamps.splice(0, row.stamps.length - 120);
    }
    const pool = dir === 'in' ? health.rxStamps : health.txStamps;
    pool.push(now);
    if (pool.length > 600) pool.splice(0, pool.length - 600);
  }

  const offEngine = subscribe(engine, 'frame', (...a) => {
    const b = toBytes(a[0] !== undefined ? a[0] : a);
    if (b) intake(b, 'in');
  });
  const offTransport = subscribe(transport, 'frame', (...a) => {
    const b = toBytes(a[0] !== undefined ? a[0] : a);
    if (b) intake(b, 'out');
  });

  /* Link-health signals from the real transport API when present. */
  const link = { peer: null, status: 'unknown' };
  const offPeer = subscribe(transport, 'peer', (p) => { link.peer = !!p; });
  const offStatus = subscribe(transport, 'status', (s) => {
    if (s != null && s !== '') link.status = String(s);
  });

  /* ---------------- corrupt-frame injector (explicit test fault) ---------------- */

  const FAULTS = [
    { kind: 'bad-start-byte', label: 'start byte 0x00 (expect 0x5A)' },
    { kind: 'bad-end-byte', label: 'end byte 0x00 (expect 0xFF)' },
    { kind: 'bad-checksum', label: 'checksum byte off by one' },
  ];
  let faultIdx = 0;

  function buildFault(kind) {
    const f = new Uint8Array(FRAME_SIZE);
    f[0] = START_CLUSTER; // cluster -> phone, so the app's inbound path is exercised
    f[1] = 0x10;
    for (let i = 2; i < 18; i++) f[i] = (i * 37 + 11) & 0xff;
    f[18] = jupiterChecksum(f);
    f[19] = END_BYTE;
    if (kind === 'bad-start-byte') f[0] = 0x00;
    if (kind === 'bad-end-byte') f[19] = 0x00;
    if (kind === 'bad-checksum') f[18] = (f[18] + 1) & 0xff;
    return f;
  }

  function sendTowardApp(frame) {
    const cands = ['sendFrame', 'sendToApp', 'send', 'write', 'inject', 'push', 'transmit'];
    for (const m of cands) {
      if (transport && typeof transport[m] === 'function') {
        try { transport[m](frame); return 'transport.' + m; }
        catch (e) { /* try next candidate */ }
      }
    }
    if (engine && typeof engine.emit === 'function') {
      try { engine.emit('frame', frame); return 'engine.emit (sim-to-app path)'; }
      catch (e) { /* fall through */ }
    }
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit('lab:inject-fault', { bytes: Array.from(frame) }); return 'bus lab:inject-fault'; }
      catch (e) { /* fall through */ }
    }
    return null;
  }

  function injectFault() {
    const fault = FAULTS[faultIdx % FAULTS.length];
    faultIdx++;
    const frame = buildFault(fault.kind);
    const via = sendTowardApp(frame);
    health.faults++;
    lastLog = via
      ? 'TEST FAULT injected (' + fault.kind + ': ' + fault.label + ') via ' + via + '.'
      : 'TEST FAULT built (' + fault.kind + ') but no transport/engine/bus send path found.';
    render(true);
  }

  /* ---------------- DOM ---------------- */

  const el = document.createElement('section');
  el.className = 'lab live';
  const style = document.createElement('style');
  style.textContent = CSS;
  el.appendChild(style);

  el.insertAdjacentHTML('beforeend', `
    <div class="lab-head">
      <span class="lab-live"><span class="lab-dot"></span><span class="lab-state">LIVE</span></span>
      <span class="lab-uptime">up <span class="lab-upv">00:00:00</span></span>
      <span class="lab-actions">
        <button class="lab-btn lab-pause" type="button">PAUSE</button>
        <button class="lab-btn lab-clear" type="button">CLEAR</button>
        <button class="lab-btn fault lab-inject" type="button">INJECT TEST FAULT</button>
      </span>
    </div>
    <div class="lab-log"><span class="lab-logv"></span></div>
    <div class="lab-grid">
      <div class="lab-tablewrap lab-sec">
        <h3>FRAME FLOW</h3>
        <table>
          <thead><tr>
            <th>ID</th><th>NAME</th><th>DIR</th>
            <th class="num">RX</th><th class="num">TX</th>
            <th class="num">LAST SEEN</th><th class="num">F/S</th><th class="num">CK</th>
          </tr></thead>
          <tbody class="lab-rows"></tbody>
        </table>
      </div>
      <div>
        <div class="lab-sec">
          <h3>LINK HEALTH</h3>
          <div class="lab-health"></div>
        </div>
        <div class="lab-sec">
          <h3>FRAME INSPECTOR</h3>
          <div class="lab-inspector"></div>
        </div>
      </div>
    </div>
    <div class="lab-note">
      <b>Observe-only.</b> The lab subscribes to engine and transport frame events;
      it never modifies, drops, or reorders frames. The CK flag is informational,
      like the app's SessionDiagnostics. The injector is the only active control and
      is always labeled as a test fault.
    </div>`);

  const rowsEl = el.querySelector('.lab-rows');
  const healthEl = el.querySelector('.lab-health');
  const inspectorEl = el.querySelector('.lab-inspector');
  const upEl = el.querySelector('.lab-upv');
  const stateEl = el.querySelector('.lab-state');
  const logEl = el.querySelector('.lab-logv');

  /* Build table skeleton once; update cells per tick. */
  const rowEls = new Map();
  {
    let html = '';
    let lastDir = null;
    for (const r of ROWS) {
      if (r.dir !== lastDir) {
        html += `<tr class="grp"><td colspan="8">${r.dir === 'in' ? 'INBOUND: CLUSTER TO PHONE (engine frames)' : 'OUTBOUND: PHONE TO CLUSTER (transport frames)'}</td></tr>`;
        lastDir = r.dir;
      }
      const key = r.dir + ':' + r.id;
      html += `<tr data-key="${key}">
        <td>${idHex(r.id)}</td><td>${r.name}</td><td>${r.dir.toUpperCase()}</td>
        <td class="num c-rx">0</td><td class="num c-tx">0</td>
        <td class="num c-last">-</td><td class="num c-rate">0.0</td>
        <td class="num c-ck"><span class="ck-na">-</span></td></tr>`;
    }
    rowsEl.innerHTML = html;
    for (const tr of rowsEl.querySelectorAll('tr[data-key]')) {
      const key = tr.getAttribute('data-key');
      rowEls.set(key, {
        tr,
        rx: tr.querySelector('.c-rx'), tx: tr.querySelector('.c-tx'),
        last: tr.querySelector('.c-last'), rate: tr.querySelector('.c-rate'),
        ck: tr.querySelector('.c-ck'),
      });
      tr.addEventListener('click', () => {
        pinnedKey = (pinnedKey === key) ? null : key;
        lastRenderedFrame = null;
        render(true);
      });
    }
  }

  function rateOf(stamps, now) {
    let n = 0;
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (now - stamps[i] > 1000) break;
      n++;
    }
    return n;
  }

  function peerInfo() {
    const t = transport || {};
    let peer = 'unknown';
    if (link.peer === true) peer = 'present';
    else if (link.peer === false) peer = 'absent';
    else {
      try {
        if (typeof t.isConnected === 'function') peer = t.isConnected() ? 'present' : 'absent';
      } catch (_) { /* ignore */ }
      if (peer === 'unknown') {
        const flags = [t.connected, t.isConnected, t.ready];
        if (flags.some((v) => v === true)) peer = 'present';
        else if (flags.some((v) => v === false)) peer = 'absent';
      }
    }
    let status = link.status;
    if (status === 'unknown') {
      status = t.status || t.state || t.readyState || (peer === 'present' ? 'connected' : 'unknown');
      status = String(status);
    }
    return { peer, status };
  }

  function render(force) {
    if (paused && !force) return;
    const now = Date.now();
    upEl.textContent = fmtUptime(now - t0);
    stateEl.textContent = paused ? 'PAUSED' : 'LIVE';
    el.classList.toggle('paused', paused);
    el.classList.toggle('live', !paused);
    logEl.textContent = lastLog;

    for (const [key, row] of rows) {
      const c = rowEls.get(key);
      if (!c) continue;
      c.rx.textContent = row.rx;
      c.tx.textContent = row.tx;
      c.last.textContent = row.lastSeen ? fmtTime(row.lastSeen) : '-';
      c.rate.textContent = rateOf(row.stamps, now).toFixed(0);
      c.ck.innerHTML = row.lastCk === null ? '<span class="ck-na">-</span>' :
        row.lastCk ? '<span class="ck-ok">ok</span>' : '<span class="ck-bad">BAD</span>';
      c.tr.classList.toggle('pinned', pinnedKey === key);
    }

    const rxRate = rateOf(health.rxStamps, now);
    const txRate = rateOf(health.txStamps, now);
    const { peer, status } = peerInfo();
    const hstats = [
      ['RX RATE', rxRate + ' f/s', rxRate > 0 ? 'ok' : ''],
      ['TX RATE', txRate + ' f/s', txRate > 0 ? 'ok' : ''],
      ['UNKNOWN IDS', String(health.unknown), health.unknown > 0 ? 'warn' : ''],
      ['CORRUPT', String(health.corrupt), health.corrupt > 0 ? 'bad' : 'ok'],
      ['FAULTS INJECTED', String(health.faults), health.faults > 0 ? 'warn' : ''],
      ['PEER', peer, peer === 'present' ? 'ok' : peer === 'absent' ? 'bad' : ''],
      ['TRANSPORT', status, ''],
    ];
    healthEl.innerHTML = hstats.map(([k, v, cls]) =>
      `<div class="lab-hstat"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`).join('');

    renderInspector();
  }

  function renderInspector() {
    const row = pinnedKey ? rows.get(pinnedKey) : null;
    if (!row || !row.lastFrame) {
      inspectorEl.innerHTML = pinnedKey
        ? '<div class="lab-empty">No frame seen yet for ' + idHex(rows.get(pinnedKey).id) + '. Click another row or wait for traffic.</div>'
        : '<div class="lab-empty">Click a frame row to pin it. The last frame for that ID appears here as hex with field decodes.</div>';
      return;
    }
    const f = row.lastFrame;
    if (f === lastRenderedFrame && !renderInspector.dirty) return;
    lastRenderedFrame = f;
    renderInspector.dirty = false;

    const ck = row.lastCk;
    let hexHtml = '<div class="lab-hex">';
    for (let i = 0; i < FRAME_SIZE; i++) {
      let cls = 'lab-byte';
      if (i === 0) cls += ' start';
      if (i === FRAME_SIZE - 1) cls += ' end';
      if (i === CHECKSUM_INDEX) cls += ck === null ? '' : ck ? ' cksum-ok' : ' cksum-bad';
      hexHtml += `<div class="${cls}"><span class="i">${i}</span><span class="b">${hex2(f[i])}</span></div>`;
    }
    hexHtml += '</div>';
    const legend = `<div class="lab-legend">
      <span><b class="sw">b0</b> start</span>
      <span><b class="ew">b19</b> end (0xFF)</span>
      <span><b class="${ck ? 'cw-ok' : 'cw-bad'}">b18</b> checksum ${ck === null ? 'n/a' : ck ? 'ok' : 'BAD'} (informational)</span>
      <span><b>b1</b> data id</span></div>`;

    const dec = decodePinned(row.id, f);
    const decHtml = '<table class="lab-decode"><tbody>' + dec.map((d) =>
      `<tr><td>${d.name}</td><td>${d.pos}</td><td>${d.value}</td></tr>`).join('') + '</tbody></table>';

    inspectorEl.innerHTML =
      `<div class="lab-pinhead"><span class="t">${idHex(row.id)} ${row.name}</span>` +
      `<span class="s">${row.dir.toUpperCase()} rx ${row.rx} tx ${row.tx} @ ${fmtTime(row.lastSeen)}</span></div>` +
      hexHtml + legend + decHtml;
  }
  renderInspector.dirty = false;

  el.querySelector('.lab-pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'RESUME' : 'PAUSE';
    lastLog = paused ? 'display paused; stream still counted.' : 'display resumed.';
    render(true);
  });
  el.querySelector('.lab-clear').addEventListener('click', () => {
    for (const row of rows.values()) {
      row.rx = 0; row.tx = 0; row.lastSeen = 0;
      row.lastFrame = null; row.lastCk = null; row.stamps = [];
    }
    health.unknown = 0; health.corrupt = 0; health.faults = 0;
    health.rxStamps = []; health.txStamps = [];
    pinnedKey = null; lastRenderedFrame = null;
    lastLog = 'counters cleared.';
    render(true);
  });
  el.querySelector('.lab-inject').addEventListener('click', injectFault);

  rootEl.appendChild(el);

  let timer = null;
  let visible = true;
  const onVis = () => { visible = !document.hidden; };
  document.addEventListener('visibilitychange', onVis);
  const tick = () => { if (visible) render(false); };
  timer = setInterval(tick, 250);
  render(true);

  function unmount() {
    if (timer) clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis);
    offEngine(); offTransport(); offPeer(); offStatus();
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { unmount, el };
}

export default { mount };
