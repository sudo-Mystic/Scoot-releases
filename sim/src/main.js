// Scoot Scooter Simulator shell (W6, integrated by W15).
//
// Wires the engine (W3) to the transport (W4) and mounts every UI panel
// module (W7-W10). Everything owned by another worker is imported
// defensively via dynamic import: the shell builds and boots even when
// modules have not landed yet.
//
// Data flow (wired at transport construction):
//   engine --('frame')--> transport.sendFrame(frame)      (sim -> app)
//   transport --('frame')--> engine.receiveFromApp(frame) (app -> sim)
//   transport --('frame')--> recorder.recordInbound(frame) (W10 recording)
//   tick loop: setInterval 50ms -> engine.tick(50)
//
// The transport is LAZY: nothing connects until the controls panel
// emits bus 'bridge:connect' { url }. main.js then constructs (or
// reconstructs) the transport with that URL, falling back to the saved
// 'scoot.bridgeUrl' localStorage value (default ws://192.168.1.1:8765).
// Transport status goes to the topbar link pill and bus 'link';
// transport 'ble' events go to the pill and bus 'link:ble'.
// 'bridge:disconnect' tears the transport down without discarding it.
//
// Cross-panel messages go through ctx.bus. Panels get
// ctx = { engine, transport, bus }; ctx.transport is null until the
// first 'bridge:connect' and is updated on every (re)construction.

import { createBus } from './bus.js';
import './styles/tokens.css';
import './styles/app.css';

const BRIDGE_URL_KEY = 'scoot.bridgeUrl';
const BRIDGE_URL_DEFAULT = 'ws://192.168.1.1:8765';

// Panels, in mount order. Each module must export mount(rootEl, ctx).
const PANELS = [
  { key: 'cluster',   module: './ui/cluster.js',   owner: 'W7'  },
  { key: 'controls',  module: './ui/controls.js',  owner: 'W8'  },
  { key: 'scenarios', module: './ui/scenarios.js', owner: 'W10' },
  { key: 'lab',       module: './ui/lab.js',       owner: 'W9'  },
];

async function loadModule(path) {
  // @vite-ignore: these modules are owned by other workers and may not
  // exist yet. Skipping resolution keeps the shell buildable standalone.
  return import(/* @vite-ignore */ path);
}

async function mountPanel(panel, ctx) {
  const host = document.querySelector(`[data-panel="${panel.key}"] [data-mount="${panel.key}"]`);
  if (!host) return null;
  try {
    const mod = await loadModule(panel.module);
    if (typeof mod.mount !== 'function') {
      console.warn(`[sim] ${panel.module} exports no mount(); skipped`);
      host.innerHTML = `<p class="panel-missing">${panel.key}: no mount export (${panel.owner})</p>`;
      return null;
    }
    const result = mod.mount(host, ctx);
    console.info(`[sim] mounted ${panel.key} (${panel.owner})`);
    return result ?? null;
  } catch (err) {
    // Module not landed yet: skip, shell stays alive for the rest.
    console.warn(`[sim] ${panel.module} unavailable (${panel.owner}); panel skipped`);
    host.innerHTML = `<p class="panel-missing">${panel.key}: pending (${panel.owner})</p>`;
    return null;
  }
}

function readSavedBridgeUrl() {
  try {
    return localStorage.getItem(BRIDGE_URL_KEY) || BRIDGE_URL_DEFAULT;
  } catch {
    return BRIDGE_URL_DEFAULT;
  }
}

function rememberBridgeUrl(url) {
  try {
    if (url) localStorage.setItem(BRIDGE_URL_KEY, url);
  } catch {
    /* storage unavailable; the session default still applies */
  }
}

async function boot() {
  const bus = createBus();
  let engine = null;
  let transportModule = null;

  // ctx is shared: panels read ctx.transport lazily; main.js keeps it
  // current on every (re)construction.
  const ctx = { engine: null, transport: null, bus };

  try {
    const engineMod = await loadModule('./engine/index.js');
    engine = engineMod.createEngine();
    ctx.engine = engine;
  } catch (err) {
    console.error('[sim] engine module missing (W3); simulator cannot tick yet');
  }

  try {
    transportModule = await loadModule('./transport.js');
  } catch (err) {
    console.error('[sim] transport module missing (W4); simulator cannot link yet');
  }

  const pill = document.getElementById('link-pill');
  const stateEl = pill ? pill.querySelector('.state') : null;
  const frameCountEl = document.getElementById('frame-count');

  function renderPill(state) {
    if (!pill || !stateEl) return;
    pill.dataset.state = state;
    stateEl.textContent = state;
  }

  // Frame wiring owned by main.js. Built at transport construction;
  // torn down before a reconstruction so listeners never double-fire.
  let unwireFrames = null;

  function wireFrames(t) {
    if (unwireFrames) {
      try { unwireFrames(); } catch { /* ignore */ }
      unwireFrames = null;
    }
    if (!t) return;
    const offs = [];
    if (engine) {
      // sim -> app
      offs.push(
        engine.on('frame', (frame) => {
          try {
            t.sendFrame(frame);
          } catch (err) {
            console.error('[sim] transport.sendFrame threw:', err);
          }
        })
      );
      // app -> sim
      offs.push(t.on('frame', (frame) => engine.receiveFromApp(frame)));
    }
    // W10 recorder: app -> sim frames into the recording, if the
    // scenarios panel is mounted and returned its recorder.
    const recorder = ctx.recorder;
    if (recorder && typeof recorder.recordInbound === 'function') {
      offs.push(
        t.on('frame', (frame) => {
          try {
            recorder.recordInbound(frame);
          } catch (err) {
            console.error('[sim] recorder.recordInbound threw:', err);
          }
        })
      );
    }
    unwireFrames = () => {
      for (const off of offs) {
        try { off(); } catch { /* ignore */ }
      }
    };
  }

  // Construct (or reconstruct) the transport against url. Called on
  // bus 'bridge:connect' from the controls panel.
  function constructTransport(url) {
    if (!transportModule || typeof transportModule.createTransport !== 'function') {
      console.warn('[sim] transport module missing; bridge:connect ignored');
      return;
    }
    const nextUrl = (typeof url === 'string' && url) || readSavedBridgeUrl();
    rememberBridgeUrl(nextUrl);
    try {
      if (ctx.transport && typeof ctx.transport.disconnect === 'function') {
        try { ctx.transport.disconnect(); } catch { /* ignore */ }
      }
      const t = transportModule.createTransport({ url: nextUrl });
      ctx.transport = t;

      t.on('status', (state) => {
        renderPill(state);
        bus.emit('link', { state });
      });
      // Phone BLE link state: topbar pill + bus for the controls panel.
      t.on('ble', (link) => {
        const connected = !!(link && link.connected);
        if (pill) pill.dataset.ble = connected ? 'up' : 'down';
        bus.emit('link:ble', { connected });
      });

      wireFrames(t);
      t.connect();
      console.info(`[sim] transport constructed -> ${nextUrl}`);
    } catch (err) {
      console.error('[sim] createTransport failed:', err);
      renderPill('error');
    }
  }

  function teardownTransport() {
    try {
      if (ctx.transport && typeof ctx.transport.disconnect === 'function') {
        ctx.transport.disconnect();
      }
    } catch {
      /* ignore */
    }
  }

  bus.on('bridge:connect', (p) => {
    const url = p && typeof p.url === 'string' && p.url.trim() ? p.url.trim() : readSavedBridgeUrl();
    constructTransport(url);
  });
  bus.on('bridge:disconnect', () => {
    teardownTransport();
  });

  // 50 ms tick loop drives the engine's physics/cluster state machine.
  // Runs on the engine alone: 'frame' emission is gated inside the
  // engine (W2 F3 fidelity gate) until the app's first write.
  if (engine) {
    setInterval(() => {
      try {
        engine.tick(50);
      } catch (err) {
        console.error('[sim] engine.tick threw:', err);
      }
    }, 50);
  }

  let frames = 0;
  bus.on('frame-count', () => {
    frames += 1;
    if (frameCountEl) frameCountEl.textContent = `${frames} frames`;
  });

  const results = {};
  await Promise.all(
    PANELS.map(async (p) => {
      results[p.key] = await mountPanel(p, ctx);
    })
  );
  // W10 recorder: the scenarios panel returns { recorder, ... } from
  // mount(). Stashed on ctx so wireFrames() can attach recordInbound at
  // transport construction (transport is lazy; scenarios mounts first).
  const scen = results.scenarios;
  if (scen && scen.recorder) ctx.recorder = scen.recorder;

  bus.emit('ready', { ctx });
  console.info('[sim] shell booted (transport lazy: click Connect in the Controls panel)');
}

boot();
