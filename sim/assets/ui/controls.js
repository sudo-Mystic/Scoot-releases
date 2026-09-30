// Scoot Scooter Simulator - operator control deck (W8).
//
// SAFETY BOUNDARY (non-negotiable): telemetry/display/mirroring bench only.
// This deck never sends vehicle-control commands (no lock/unlock,
// immobilizer, ignition-cut, throttle or brake to the vehicle) and never
// constructs 0x9A/0xF2/0xF1 auth frames. The "Key" switch below is the
// rider's PHYSICAL key: sim side only, the Scoot app cannot toggle it.
//
// W1/protocol-spec finding (2026-09-30): trip-reset and tyre-pressure
// builder frames do not exist in the Scoot sources, so this deck invents no
// outbound frames for them. Trip A/B reset calls
// engine.controls.resetTrip('A'|'B') which resets the sim's own trip
// counters (surfaced in 0x10 telemetry the app already reads). Tyre
// pressure is a sim-side simulated sensor readout shown on the sim
// cluster, clearly labeled as simulated.
//
// Music/call buttons inject frames on the sim->app channel to exercise
// Scoot's inbound parsing. They mirror what the real handlebar cluster
// sends (0x6B) or test-bench injections (0x43 caller info), labeled as
// such in the UI. The SMS button is disabled on purpose: 0x53 flows
// phone->cluster, so the sim cannot inject it; the operator tests SMS by
// triggering one on the phone instead.
//
// mount(rootEl, ctx) with ctx = { engine, transport, bus }. Engine and
// transport are optional: the deck renders with disabled states and reason
// tooltips when they are missing or when their APIs differ slightly.


// Common OBD-II style fault codes offered in the DTC dropdown.
const COMMON_DTCS = [
  'P0131', 'P0132', 'P0171', 'P0172', 'P0201', 'P0300',
  'P0335', 'P0500', 'P0562', 'P0563', 'P062F', 'U0100',
];

// 0x6B music command map, dex-verified (BluetoothUtil.getMusicCommandType).
const MUSIC = [
  { label: 'Play', cmd: 0 },
  { label: 'Pause', cmd: 1 },
  { label: 'Next', cmd: 3 },
  { label: 'Prev', cmd: 4 },
  { label: 'Vol up', cmd: 5 },
  { label: 'Vol down', cmd: 6 },
];

export function mount(rootEl, ctx) {
  const engine = ctx && ctx.engine ? ctx.engine : null;
  const bus = ctx && ctx.bus ? ctx.bus : null;

  // The transport is LAZY (main.js constructs it on bus
  // 'bridge:connect'): ctx.transport starts null and is replaced on
  // every (re)construction, so always re-read it. `transportAtMount`
  // is the feature-detection fallback for shells that pass one.
  const transportAtMount = ctx && ctx.transport ? ctx.transport : null;
  function liveTransport() {
    return (ctx && ctx.transport ? ctx.transport : null) || transportAtMount;
  }

  // Engine controls surface. W3 exposes engine.controls; if the engine
  // implements the same methods directly, use it as the fallback.
  const controls = (() => {
    if (engine && engine.controls && typeof engine.controls === 'object') {
      return engine.controls;
    }
    if (engine && typeof engine.setKey === 'function') return engine;
    return null;
  })();

  const hasEngine = !!controls;
  // hasTransport is a mount-time fallback only; the link section treats
  // "no transport yet but the bus is up" as connectable (the Connect
  // click is what makes main.js construct the transport).
  const hasTransportAtMount = !!transportAtMount;
  const canSignalBus = !!(bus && typeof bus.emit === 'function');

  rootEl.textContent = '';
  const deck = document.createElement('div');
  deck.className = 'cd';
  rootEl.appendChild(deck);

  // ---------- small helpers ----------

  function now() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  function note(text) {
    const line = statusEl.querySelector('.msg');
    if (line) line.textContent = text;
    const at = statusEl.querySelector('.at');
    if (at) at.textContent = now();
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit('deck:note', { text, at: now() }); } catch (e) { /* ignore */ }
    }
  }

  // Safe engine-controls call. Returns true when the method existed and ran.
  function ctl(method, ...args) {
    if (!controls || typeof controls[method] !== 'function') {
      note(`controls.${method} unavailable on this engine build`);
      return false;
    }
    try {
      controls[method](...args);
      return true;
    } catch (err) {
      console.error(`[controls] controls.${method} threw:`, err);
      note(`controls.${method} failed, see console`);
      return false;
    }
  }

  function engineState() {
    if (!engine) return null;
    try {
      if (typeof engine.getState === 'function') return engine.getState();
      if (engine.state && typeof engine.state === 'object') return engine.state;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Send raw bytes sim -> app (inbound direction, cluster -> phone).
  // Gated on the app peer (the phone's BLE link to the bridge) being up.

  function sendToApp(bytes) {
    if (!appLinked()) {
      note('App link is down, frame not sent');
      return false;
    }
    const t = liveTransport();
    if (t && typeof t.sendFrame === 'function') {
      try {
        t.sendFrame(bytes);
        if (bus && typeof bus.emit === 'function') bus.emit('frame-count');
        return true;
      } catch (err) {
        console.error('[controls] transport.sendFrame threw:', err);
        note('sendFrame failed, see console');
        return false;
      }
    }
    note('Transport not constructed yet, frame not sent');
    return false;
  }

  function utf8Truncate(str, maxBytes) {
    const enc = new TextEncoder();
    const out = [];
    for (const ch of str) {
      const b = Array.from(enc.encode(ch));
      if (out.length + b.length > maxBytes) break;
      out.push(...b);
    }
    return out;
  }

  // 20-byte inbound frame (cluster -> phone): 0x5A, id, payload, 0xFF.
  function inboundFrame(id, payloadBytes) {
    const f = new Array(20).fill(0);
    f[0] = 0x5A;
    f[1] = id & 0xff;
    const n = Math.min(payloadBytes.length, 17);
    for (let i = 0; i < n; i++) f[2 + i] = payloadBytes[i] & 0xff;
    f[19] = 0xFF;
    return f;
  }

  // 0x43 caller-info packet (three-packet sequence: number, country, name).
  // Test injection: exercises Scoot's inbound caller parsing.
  function callerPacket(subId, text) {
    const body = utf8Truncate(text, 17);
    const f = [0x5B, 0x43, subId & 0xff, ...body];
    while (f.length < 19) f.push(0x00);
    f.push(0xFF);
    return f;
  }

  function splitNumber(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length > 10) {
      return { cc: digits.slice(0, digits.length - 10), national: digits.slice(-10) };
    }
    return { cc: '91', national: digits };
  }

  // ---------- static markup ----------

  deck.innerHTML = `
    ${!hasEngine || !hasTransportAtMount ? `
    <div class="cd-banner" role="status">
      ${!hasEngine ? 'Engine not loaded yet. Sim-side controls are disabled.' : ''}
      ${!hasEngine && !hasTransportAtMount ? ' ' : ''}
      ${!hasTransportAtMount ? 'Bridge transport not constructed yet. Click Connect and main.js will build it.' : ''}
    </div>` : ''}
    <div class="cd-status" aria-live="polite"><span class="at num">--:--:--</span> <span class="msg">Deck ready.</span></div>

    <div class="cd-section" data-sec="link">
      <div class="cd-sec-head"><span class="t">Connection</span> <span class="n">phone app via bridge</span></div>
      <div class="cd-grid">
        <div class="cd-row">
          <label class="field" for="cd-bridge-url">Bridge URL</label>
          <div class="cd-inline">
            <input type="text" id="cd-bridge-url" class="num" spellcheck="false" autocomplete="off"
              placeholder="ws://192.168.1.1:8765" />
            <button class="btn" id="cd-copy-url" type="button">Copy</button>
          </div>
          <div class="cd-inline" style="margin-top:8px">
            <button class="btn primary" id="cd-connect" type="button">Connect</button>
          </div>
          <div class="cd-inline" style="margin-top:8px">
            <div class="cd-peer" data-on="false" id="cd-bridge">
              <span class="cd-led" data-on="false"></span><span class="peer-text">No bridge</span>
            </div>
            <span class="cd-linkstate" id="cd-bridgestate">bridge: unknown</span>
          </div>
          <div class="cd-inline" style="margin-top:8px">
            <div class="cd-peer" data-on="false" id="cd-phone">
              <span class="cd-led" data-on="false"></span><span class="peer-text">Phone: waiting for bridge</span>
            </div>
          </div>
        </div>
      </div>
      <p class="cd-caption">The phone app pairs over Bluetooth to the bridge on this machine, the way it pairs with the real cluster. Enter the bridge address below and connect.</p>
    </div>

    <div class="cd-section" data-sec="key">
      <div class="cd-sec-head"><span class="t">Key and ride</span> <span class="n">physical controls</span></div>
      <div class="cd-grid">
        <div class="cd-row">
          <label class="cd-key">
            <input type="checkbox" id="cd-key" />
            <span class="cd-key-track" aria-hidden="true"><span class="cd-key-thumb"></span></span>
            <span class="cd-key-label">Key<span class="cd-key-state num" id="cd-key-state">OFF</span></span>
          </label>
          <p class="cd-caption">The rider's physical key on the bench. Sim side only. The Scoot app cannot toggle it. Key ON implies the engine is running.</p>
        </div>
        <div class="cd-row">
          <label class="field" for="cd-throttle">Throttle</label>
          <div class="cd-slider-row">
            <input type="range" id="cd-throttle" min="0" max="100" step="1" value="0" />
            <output class="cd-num num" id="cd-throttle-out" data-num>0<span class="unit">%</span></output>
          </div>
          <label class="field" for="cd-cruise" style="margin-top:6px">Cruise speed</label>
          <div class="cd-inline">
            <input type="number" id="cd-cruise" class="num" min="10" max="110" step="1" value="40" />
            <button class="btn" id="cd-cruise-set" type="button">Set cruise</button>
            <button class="btn" id="cd-cruise-clear" type="button">Clear</button>
          </div>
        </div>
      </div>
    </div>

    <div class="cd-section" data-sec="vehicle">
      <div class="cd-sec-head"><span class="t">Vehicle state</span> <span class="n">sim model inputs</span></div>
      <div class="cd-grid">
        <div class="cd-row">
          <label class="field" for="cd-fuel">Fuel in tank</label>
          <div class="cd-slider-row">
            <input type="range" id="cd-fuel" min="0" max="6" step="0.1" value="4" />
            <output class="cd-num num" id="cd-fuel-out" data-num>4.0<span class="unit">L</span></output>
          </div>
          <label class="field" for="cd-temp" style="margin-top:6px">Engine temp override</label>
          <div class="cd-inline">
            <input type="number" id="cd-temp" class="num" min="-20" max="160" step="1" placeholder="e.g. 95" />
            <button class="btn" id="cd-temp-apply" type="button">Apply</button>
            <button class="btn" id="cd-temp-auto" type="button">Auto</button>
          </div>
          <p class="cd-caption">Auto follows the sim thermal model. Apply pins a fixed value for testing.</p>
        </div>
        <div class="cd-row">
          <span class="field">Odometer</span>
          <div class="cd-num num" id="cd-odo" data-num style="font-size:20px; text-align:left">--<span class="unit">km</span></div>
          <p class="cd-caption">Read only. Driven by the sim engine.</p>
        </div>
      </div>
    </div>

    <div class="cd-section" data-sec="trips">
      <div class="cd-sec-head"><span class="t">Trips</span> <span class="n"><span class="sim">sim side</span></span></div>
      <div class="cd-btn-row">
        <button class="btn" id="cd-trip-a" type="button">Reset trip A</button>
        <button class="btn" id="cd-trip-b" type="button">Reset trip B</button>
      </div>
      <p class="cd-caption"><span class="sim">Sim side only.</span> No trip-reset frame exists on the wire, so none is invented. This resets the sim's own trip counters, which then appear in the 0x10 telemetry the app already reads.</p>
    </div>

    <div class="cd-section" data-sec="diag">
      <div class="cd-sec-head"><span class="t">Diagnostics</span> <span class="n">faults and sensors</span></div>
      <div class="cd-grid">
        <div class="cd-row">
          <label class="field" for="cd-dtc">Fault code</label>
          <div class="cd-inline">
            <select id="cd-dtc">
              ${COMMON_DTCS.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
            <button class="btn" id="cd-dtc-inject" type="button">Inject DTC</button>
          </div>
          <div class="cd-inline" style="margin-top:8px">
            <input type="text" id="cd-dtc-custom" class="num" spellcheck="false" autocomplete="off" placeholder="custom, e.g. P1234" />
            <button class="btn" id="cd-dtc-clear" type="button">Clear DTCs</button>
          </div>
          <div class="cd-dtc-count num" id="cd-dtc-count" data-num>latched: --</div>
        </div>
        <div class="cd-row">
          <span class="field"><span class="sim">Simulated</span> tyre pressure</span>
          <label class="field" for="cd-tyre-f">Front</label>
          <div class="cd-slider-row">
            <input type="range" id="cd-tyre-f" min="0" max="60" step="1" value="32" />
            <output class="cd-num num" id="cd-tyre-f-out" data-num>32<span class="unit">psi</span></output>
          </div>
          <label class="field" for="cd-tyre-r" style="margin-top:4px">Rear</label>
          <div class="cd-slider-row">
            <input type="range" id="cd-tyre-r" min="0" max="60" step="1" value="36" />
            <output class="cd-num num" id="cd-tyre-r-out" data-num>36<span class="unit">psi</span></output>
          </div>
        </div>
      </div>
      <p class="cd-caption"><span class="sim">Simulated sensors.</span> No tyre-pressure frame exists on the wire. These values show on the sim cluster only.</p>
    </div>

    <div class="cd-section" data-sec="cluster">
      <div class="cd-sec-head"><span class="t">Cluster buttons</span> <span class="n">handlebar and call</span></div>
      <div class="cd-grid">
        <div class="cd-row">
          <span class="field">Music (sends 0x6B)</span>
          <div class="cd-btn-row" id="cd-music">
            ${MUSIC.map((m) => `<button class="btn" type="button" data-cmd="${m.cmd}">${m.label}</button>`).join('')}
          </div>
          <p class="cd-caption">Same frames the real handlebar buttons emit. Needs the app link.</p>
        </div>
        <div class="cd-row">
          <span class="field">Incoming call simulator</span>
          <div class="cd-inline">
            <input type="text" id="cd-call-name" autocomplete="off" placeholder="Name" />
            <input type="text" id="cd-call-num" class="num" autocomplete="off" spellcheck="false" placeholder="Number" />
          </div>
          <div class="cd-btn-row" style="margin-top:8px">
            <button class="btn" id="cd-call-start" type="button">Start call</button>
            <button class="btn" id="cd-call-end" type="button" disabled>End call</button>
          </div>
          <p class="cd-caption">Test injection. Sends 0x43 caller-info frames to the app to exercise Scoot's inbound parsing. Not a real cluster behavior.</p>
        </div>
      </div>
      <div class="cd-grid" style="margin-top:10px">
        <div class="cd-row">
          <span class="field">SMS simulator</span>
          <div class="cd-inline">
            <input type="text" id="cd-sms-from" autocomplete="off" placeholder="Sender" disabled title="The sim cannot inject SMS frames" />
            <input type="text" id="cd-sms-text" autocomplete="off" placeholder="Message" disabled title="The sim cannot inject SMS frames" />
          </div>
          <div class="cd-btn-row" style="margin-top:8px">
            <button class="btn" id="cd-sms-send" type="button" disabled title="The sim cannot inject SMS frames">Send SMS</button>
          </div>
          <p class="cd-caption">SMS arrives from the phone over BLE, like the real scooter. Trigger one on your phone to test; the sim cannot inject it.</p>
        </div>
      </div>
    </div>

    <div class="cd-section" data-sec="route">
      <div class="cd-sec-head"><span class="t">Route playback</span> <span class="n">speed profile driver</span></div>
      <div class="cd-grid-1">
        <div class="cd-row">
          <label class="field" for="cd-route-text">Waypoints, one lat,lng per line</label>
          <textarea class="cd-route-text num" id="cd-route-text" spellcheck="false" placeholder="12.9716,77.5946&#10;12.9352,77.6245"></textarea>
          <div class="cd-route-meta" id="cd-route-meta">No waypoints. Add lat,lng lines above.</div>
        </div>
        <div class="cd-row">
          <span class="field">Speed multiplier</span>
          <div class="cd-inline">
            <div class="cd-seg" id="cd-speed-seg" role="group" aria-label="Speed multiplier">
              ${[0.5, 1, 2, 4].map((m) => `<button type="button" data-mult="${m}" aria-pressed="${m === 1}">${m}x</button>`).join('')}
            </div>
            <span class="cd-route-state" id="cd-route-state">idle</span>
          </div>
          <div class="cd-btn-row" style="margin-top:10px">
            <button class="btn primary" id="cd-route-start" type="button">Start</button>
            <button class="btn" id="cd-route-pause" type="button" disabled>Pause</button>
            <button class="btn" id="cd-route-stop" type="button" disabled>Stop</button>
          </div>
          <p class="cd-caption">Drives the speed profile through the sim engine. The app sees the resulting 0x10 telemetry.</p>
        </div>
      </div>
    </div>
  `;

  const statusEl = deck.querySelector('.cd-status');
  const $ = (sel) => deck.querySelector(sel);

  // ---------- link state (bridge + phone) ----------

  const BRIDGE_URL_KEY = 'scoot.bridgeUrl';
  const BRIDGE_URL_DEFAULT = 'ws://192.168.1.1:8765';
  // W4-bridge status vocabulary may differ slightly from the old relay one;
  // treat either 'open' or 'connected' as an up link.
  const BRIDGE_UP = new Set(['open', 'connected']);

  let linkState = 'unknown'; // bridge transport state
  let phoneConnected = false; // phone app BLE link, from 'ble' events
  let connecting = false;

  const bridgeEl = $('#cd-bridge');
  const bridgeLed = bridgeEl.querySelector('.cd-led');
  const bridgeText = bridgeEl.querySelector('.peer-text');
  const bridgeStateEl = $('#cd-bridgestate');
  const phoneEl = $('#cd-phone');
  const phoneLed = phoneEl.querySelector('.cd-led');
  const phoneText = phoneEl.querySelector('.peer-text');
  const connectBtn = $('#cd-connect');
  const urlInput = $('#cd-bridge-url');
  const copyUrlBtn = $('#cd-copy-url');

  function transportUrl() {
    const t = liveTransport();
    if (!t) return '';
    try {
      if (typeof t.url === 'string' && t.url) return t.url;
      if (typeof t.relayUrl === 'string' && t.relayUrl) return t.relayUrl;
      if (typeof t.getUrl === 'function') return t.getUrl() || '';
      if (typeof t.getRelayUrl === 'function') return t.getRelayUrl() || '';
    } catch (e) { /* ignore */ }
    return '';
  }

  function savedBridgeUrl() {
    try {
      return localStorage.getItem(BRIDGE_URL_KEY) || '';
    } catch (e) { return ''; }
  }

  function rememberBridgeUrl(url) {
    try { localStorage.setItem(BRIDGE_URL_KEY, url); } catch (e) { /* ignore */ }
  }

  function bridgeUp() { return BRIDGE_UP.has(linkState); }

  // App link gate for frame injection: the phone's BLE link to the bridge.
  function appLinked() { return phoneConnected; }

  // Phone row, derived only from real link state. The bridge transport
  // emits 'ble' with the current state on subscribe, so 'Phone: waiting
  // for bridge' only ever shows while the bridge itself is down; a bridge
  // that is up but has no phone shows 'Phone: not connected'. Nothing here
  // is guessed from timeouts.
  function phoneLabel() {
    if (phoneConnected) return 'Phone app connected';
    if (!bridgeUp()) return 'Phone: waiting for bridge';
    return 'Phone: not connected';
  }

  function refreshLink() {
    const up = bridgeUp();
    bridgeEl.dataset.on = up ? 'true' : 'false';
    bridgeLed.dataset.on = up ? 'true' : 'false';
    bridgeText.textContent = up ? 'Bridge connected' : 'No bridge';
    bridgeStateEl.textContent = `bridge: ${linkState}`;
    phoneEl.dataset.on = phoneConnected ? 'true' : 'false';
    phoneLed.dataset.on = phoneConnected ? 'true' : 'false';
    phoneText.textContent = phoneLabel();
    // Lazy transport: the Connect button is usable even before main.js
    // has constructed the transport, because the click itself (via the
    // bus) is what constructs it.
    if (!liveTransport()) {
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = connecting || !canSignalBus;
      connectBtn.title = canSignalBus
        ? 'Construct the bridge transport via main.js'
        : 'No bus: cannot signal connect';
      urlInput.disabled = connecting;
      return;
    }
    if (up) {
      connectBtn.textContent = 'Disconnect';
      connectBtn.disabled = connecting;
    } else {
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = connecting;
    }
    connectBtn.title = '';
    urlInput.disabled = up || connecting;
    // frame-emitting controls need the phone link
    const frameOk = appLinked();
    deck.querySelectorAll('[data-needs-link]').forEach((b) => {
      b.disabled = !frameOk || b.dataset.lock === 'true';
      b.title = frameOk ? '' : 'Needs the phone link';
    });
  }

  // W4-bridge may take the URL at construction, or via a setter. Try the
  // known setter names defensively; otherwise connect() uses its own URL.
  function setTransportUrl(url) {
    const t = liveTransport();
    if (!t) return;
    const setters = ['setBridgeUrl', 'setUrl', 'setRelayUrl'];
    for (const name of setters) {
      if (typeof t[name] === 'function') {
        try { t[name](url); return; } catch (e) { /* try the next */ }
      }
    }
  }

  function doConnect() {
    // Lazy transport (main.js owns construction): signal on the bus.
    // Direct transport calls are the fallback when the bus is absent.
    if (bridgeUp()) {
      const t = liveTransport();
      if (canSignalBus) {
        bus.emit('bridge:disconnect');
        note('Disconnect requested');
      } else if (t && typeof t.disconnect === 'function') {
        try { t.disconnect(); note('Disconnect requested'); } catch (e) { note('Disconnect failed, see console'); }
      } else {
        note('Transport has no disconnect()');
      }
      return;
    }
    const url = (urlInput.value || '').trim() || BRIDGE_URL_DEFAULT;
    rememberBridgeUrl(url);
    connecting = true;
    refreshLink();
    if (canSignalBus) {
      bus.emit('bridge:connect', { url });
      note(`Connect requested to ${url}`);
      return;
    }
    const t = liveTransport();
    if (t && typeof t.connect === 'function') {
      setTransportUrl(url);
      try {
        t.connect();
        note(`Connect requested to ${url}`);
      } catch (err) {
        connecting = false;
        note('Connect failed, see console');
        refreshLink();
      }
      return;
    }
    connecting = false;
    note('Cannot signal connect: no bus and no transport');
    refreshLink();
  }

  function copyText(text, okNote) {
    if (!text) {
      note('Nothing to copy');
      return;
    }
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); note(okNote); }
      catch (err) { note('Copy failed, select the text manually'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => note(okNote), fallback);
    } else {
      fallback();
    }
  }

  // Feature-detection fallback: if a transport was handed in at mount
  // (or has since appeared on ctx), subscribe directly. The bus
  // listeners below cover the lazy main.js-owned transport.
  const t0 = liveTransport();
  if (t0 && typeof t0.on === 'function') {
    try {
      t0.on('status', (s) => {
        linkState = typeof s === 'string' ? s : (s && (s.state || s.status)) || 'unknown';
        if (linkState !== 'connecting') connecting = false;
        refreshLink();
      });
    } catch (e) { /* ignore */ }
    // The bridge emits on('ble', { connected: bool }), and fires once with
    // the current state on subscribe. Older relay-style transports throw on
    // unknown events; for those, fall back to 'peer' presence.
    try {
      t0.on('ble', (p) => {
        phoneConnected = !!(p && (p.connected ?? p.present ?? p.online ?? false));
        connecting = false;
        refreshLink();
        note(phoneConnected ? 'Phone app connected over BLE' : 'Phone BLE link down');
      });
    } catch (e) {
      try {
        t0.on('peer', (p) => {
          phoneConnected = typeof p === 'boolean' ? p : !!(p && (p.connected ?? p.present ?? p.online ?? false));
          connecting = false;
          refreshLink();
          note(phoneConnected ? 'App peer joined' : 'App peer left');
        });
      } catch (err) { /* ignore */ }
    }
  }
  if (bus && typeof bus.on === 'function') {
    // main.js shell emits 'link' with { state } on bridge status changes.
    bus.on('link', (p) => {
      if (p && p.state) {
        linkState = p.state;
        if (linkState !== 'connecting') connecting = false;
        refreshLink();
      }
    });
    // main.js re-emits the transport's 'ble' events here (lazy path).
    bus.on('link:ble', (p) => {
      phoneConnected = !!(p && p.connected);
      connecting = false;
      refreshLink();
    });
  }

  connectBtn.addEventListener('click', doConnect);
  copyUrlBtn.addEventListener('click', () => copyText((urlInput.value || '').trim(), 'Bridge URL copied'));

  // Bridge URL: last-used value wins, then the transport's own default,
  // then the hard default. Editable while disconnected.
  if (!urlInput.value) {
    urlInput.value = savedBridgeUrl() || transportUrl() || BRIDGE_URL_DEFAULT;
  }

  // ---------- engine controls: disable when no engine ----------

  if (!hasEngine) {
    deck.querySelectorAll(
      '#cd-key, #cd-throttle, #cd-cruise, #cd-cruise-set, #cd-cruise-clear, ' +
      '#cd-fuel, #cd-temp, #cd-temp-apply, #cd-temp-auto, ' +
      '#cd-trip-a, #cd-trip-b, #cd-dtc, #cd-dtc-inject, #cd-dtc-custom, #cd-dtc-clear, ' +
      '#cd-tyre-f, #cd-tyre-r, #cd-route-text, #cd-route-start, #cd-route-pause, #cd-route-stop, ' +
      '#cd-speed-seg button'
    ).forEach((el) => {
      el.disabled = true;
      el.title = 'Engine not loaded yet';
    });
  }

  // ---------- key and ride ----------

  const keyInput = $('#cd-key');
  const keyState = $('#cd-key-state');
  keyInput.addEventListener('change', () => {
    const on = keyInput.checked;
    keyState.textContent = on ? 'ON' : 'OFF';
    if (ctl('setKey', on)) note(`Physical key ${on ? 'ON, engine running' : 'OFF'}`);
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit('deck:key', { on }); } catch (e) { /* ignore */ }
    }
  });

  const throttle = $('#cd-throttle');
  const throttleOut = $('#cd-throttle-out');
  throttle.addEventListener('input', () => {
    const v = Number(throttle.value);
    throttleOut.innerHTML = `${v}<span class="unit">%</span>`;
    ctl('setThrottle', v);
  });
  throttle.addEventListener('change', () => note(`Throttle ${throttle.value}%`));

  const cruiseInput = $('#cd-cruise');
  $('#cd-cruise-set').addEventListener('click', () => {
    const v = Math.max(10, Math.min(110, Number(cruiseInput.value) || 40));
    cruiseInput.value = String(v);
    if (ctl('setCruise', v)) note(`Cruise set to ${v} km/h`);
  });
  $('#cd-cruise-clear').addEventListener('click', () => {
    if (ctl('clearCruise')) note('Cruise cleared');
  });

  // ---------- vehicle state ----------

  const fuel = $('#cd-fuel');
  const fuelOut = $('#cd-fuel-out');
  fuel.addEventListener('input', () => {
    const v = Number(fuel.value);
    fuelOut.innerHTML = `${v.toFixed(1)}<span class="unit">L</span>`;
    ctl('setFuel', v);
  });
  fuel.addEventListener('change', () => note(`Fuel ${Number(fuel.value).toFixed(1)} L`));

  const tempInput = $('#cd-temp');
  $('#cd-temp-apply').addEventListener('click', () => {
    const v = Number(tempInput.value);
    if (!Number.isFinite(v)) {
      note('Enter a temperature in C first');
      return;
    }
    if (ctl('setEngineTempOverride', v)) note(`Engine temp pinned to ${v} C`);
  });
  $('#cd-temp-auto').addEventListener('click', () => {
    tempInput.value = '';
    if (ctl('clearEngineTempOverride')) note('Engine temp back to auto');
  });

  const odoEl = $('#cd-odo');
  function renderOdo() {
    const st = engineState();
    const odo = st ? (st.odometer ?? st.odo ?? st.km ?? null) : null;
    if (typeof odo === 'number' && Number.isFinite(odo)) {
      odoEl.innerHTML = `${odo.toFixed(1)}<span class="unit">km</span>`;
    } else {
      odoEl.innerHTML = `--<span class="unit">km</span>`;
    }
  }

  // ---------- trips (sim side only) ----------

  $('#cd-trip-a').addEventListener('click', () => {
    if (ctl('resetTrip', 'A')) note('Trip A reset on the sim');
  });
  $('#cd-trip-b').addEventListener('click', () => {
    if (ctl('resetTrip', 'B')) note('Trip B reset on the sim');
  });

  // ---------- diagnostics ----------

  const dtcCount = $('#cd-dtc-count');
  $('#cd-dtc-inject').addEventListener('click', () => {
    const code = ($('#cd-dtc-custom').value || '').trim() || $('#cd-dtc').value;
    if (ctl('injectDTC', code.toUpperCase())) note(`DTC ${code.toUpperCase()} injected`);
    renderDtcCount();
  });
  $('#cd-dtc-clear').addEventListener('click', () => {
    if (ctl('clearDTCs')) note('DTCs cleared');
    renderDtcCount();
  });
  function renderDtcCount() {
    const st = engineState();
    const n = st && Array.isArray(st.dtcs) ? st.dtcs.length : null;
    dtcCount.textContent = n === null ? 'latched: --' : `latched: ${n}`;
  }

  const tyreF = $('#cd-tyre-f');
  const tyreFOut = $('#cd-tyre-f-out');
  const tyreR = $('#cd-tyre-r');
  const tyreROut = $('#cd-tyre-r-out');
  function pushTyre() {
    const f = Number(tyreF.value);
    const r = Number(tyreR.value);
    tyreFOut.innerHTML = `${f}<span class="unit">psi</span>`;
    tyreROut.innerHTML = `${r}<span class="unit">psi</span>`;
    ctl('setTyrePressure', f, r);
  }
  tyreF.addEventListener('input', pushTyre);
  tyreR.addEventListener('input', pushTyre);
  tyreF.addEventListener('change', () => note(`Tyre pressure simulated: ${tyreF.value}/${tyreR.value} psi`));
  tyreR.addEventListener('change', () => note(`Tyre pressure simulated: ${tyreF.value}/${tyreR.value} psi`));

  // ---------- cluster buttons ----------

  $('#cd-music').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-cmd]');
    if (!btn || btn.disabled) return;
    const cmd = Number(btn.dataset.cmd);
    if (sendToApp(inboundFrame(0x6B, [cmd]))) note(`Music button sent: ${btn.textContent.trim()}`);
  });

  const callName = $('#cd-call-name');
  const callNum = $('#cd-call-num');
  const callStart = $('#cd-call-start');
  const callEnd = $('#cd-call-end');
  callStart.dataset.needsLink = 'true';
  callStart.dataset.lock = 'false';
  callEnd.dataset.needsLink = 'true';
  callEnd.dataset.lock = 'true';

  callStart.addEventListener('click', () => {
    const name = callName.value.trim();
    const { cc, national } = splitNumber(callNum.value);
    if (!national) {
      note('Enter a number first');
      return;
    }
    // Sub-packet order per the dex: 0x01 national, 0x03 country, 0x02 name.
    const frames = [callerPacket(0x01, national), callerPacket(0x03, cc)];
    if (name) frames.push(callerPacket(0x02, name));
    const okAll = frames.every((f) => sendToApp(f));
    if (okAll) {
      note(`Call simulated from ${name || 'unknown'} ${national}`);
      callStart.dataset.lock = 'true';
      callStart.disabled = true;
      callEnd.dataset.lock = 'false';
      callEnd.disabled = false;
      ctl('setCallActive', true);
    }
  });
  callEnd.addEventListener('click', () => {
    callStart.dataset.lock = 'false';
    callStart.disabled = !appLinked();
    callEnd.dataset.lock = 'true';
    callEnd.disabled = true;
    ctl('setCallActive', false);
    note('Call simulation ended');
  });

  // SMS is intentionally inert in this deck: 0x53 flows phone->cluster, so
  // the sim cannot inject it. The button and inputs are disabled in the
  // markup above, with a caption telling the operator to trigger an SMS on
  // the phone instead. No 0x53 frame is constructed here.

  // music buttons also need the link
  deck.querySelectorAll('#cd-music button').forEach((b) => { b.dataset.needsLink = 'true'; });

  // ---------- route playback ----------

  const routeText = $('#cd-route-text');
  const routeMeta = $('#cd-route-meta');
  const routeStateEl = $('#cd-route-state');
  const routeStartBtn = $('#cd-route-start');
  const routePauseBtn = $('#cd-route-pause');
  const routeStopBtn = $('#cd-route-stop');
  const seg = $('#cd-speed-seg');
  let speedMult = 1;
  let routeState = 'idle'; // idle | running | paused
  let waypoints = [];

  function parseWaypoints(text) {
    const pts = [];
    const errors = [];
    text.split('\n').forEach((rawLine, i) => {
      const line = rawLine.trim();
      if (!line) return;
      const m = line.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (!m) {
        errors.push(`line ${i + 1}: expected lat,lng`);
        return;
      }
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        errors.push(`line ${i + 1}: out of range`);
        return;
      }
      pts.push({ lat, lng });
    });
    return { pts, errors };
  }

  function refreshRouteMeta() {
    const { pts, errors } = parseWaypoints(routeText.value);
    waypoints = pts;
    let html = pts.length
      ? `${pts.length} waypoint${pts.length === 1 ? '' : 's'} parsed`
      : 'No waypoints. Add lat,lng lines above.';
    errors.slice(0, 4).forEach((e) => { html += `<span class="err">${e}</span>`; });
    if (errors.length > 4) html += `<span class="err">+${errors.length - 4} more errors</span>`;
    routeMeta.innerHTML = html;
    if (hasEngine) {
      const bad = routeState !== 'idle' || pts.length < 2 || errors.length > 0;
      routeStartBtn.disabled = bad;
      routeStartBtn.title = routeState !== 'idle'
        ? 'Route already active'
        : (pts.length < 2 ? 'Need at least 2 valid waypoints' : (errors.length ? 'Fix waypoint errors first' : ''));
    }
  }

  function renderRouteState() {
    routeStateEl.textContent = routeState === 'running' ? `running ${speedMult}x` : routeState;
    routeStateEl.dataset.live = routeState === 'running' ? 'true' : 'false';
    if (!hasEngine) return;
    routePauseBtn.disabled = routeState !== 'running';
    routePauseBtn.title = routeState === 'running' ? '' : 'Start a route first';
    routeStopBtn.disabled = routeState === 'idle';
    routeStopBtn.title = routeState === 'idle' ? 'No route running' : '';
    routePauseBtn.textContent = routeState === 'paused' ? 'Resume' : 'Pause';
    refreshRouteMeta(); // owns the start button's waypoint validation
  }

  routeText.addEventListener('input', refreshRouteMeta);

  seg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-mult]');
    if (!btn || btn.disabled) return;
    speedMult = Number(btn.dataset.mult);
    seg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    renderRouteState();
    note(`Route speed ${speedMult}x`);
  });

  routeStartBtn.addEventListener('click', () => {
    refreshRouteMeta();
    if (waypoints.length < 2) {
      note('Need at least 2 waypoints');
      return;
    }
    if (ctl('routeStart', waypoints, { speedMultiplier: speedMult })) {
      routeState = 'running';
      renderRouteState();
      note(`Route started: ${waypoints.length} waypoints at ${speedMult}x`);
    }
  });
  routePauseBtn.addEventListener('click', () => {
    if (routeState === 'running') {
      if (ctl('routePause')) {
        routeState = 'paused';
        renderRouteState();
        note('Route paused');
      }
    } else if (routeState === 'paused') {
      // Resume re-issues the profile with the current multiplier.
      if (ctl('routeStart', waypoints, { speedMultiplier: speedMult, resume: true })) {
        routeState = 'running';
        renderRouteState();
        note('Route resumed');
      }
    }
  });
  routeStopBtn.addEventListener('click', () => {
    if (ctl('routeStop')) {
      routeState = 'idle';
      renderRouteState();
      refreshRouteMeta();
      note('Route stopped');
    }
  });

  // ---------- periodic sync ----------

  function sync() {
    renderOdo();
    renderDtcCount();
  }
  refreshLink();
  refreshRouteMeta();
  renderRouteState();
  renderOdo();
  renderDtcCount();
  note(hasEngine ? 'Deck ready.' : 'Deck ready (engine pending).');
  setInterval(sync, 1000);
}
