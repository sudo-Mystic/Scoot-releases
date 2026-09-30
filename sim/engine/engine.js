// Scoot scooter simulator engine: cluster-side BLE frame source for the
// Scoot Flutter app. Pure logic, zero dependencies, no DOM.
//
// PROFILE INTERFACE (implemented by sim/src/engine/profiles.js, worker
// W11; this module must also satisfy sim/CONTRACT.md section 2):
//
//   {
//     id: 'jupiter110' | 'jupiter125' | 'ntorq',   // registry key
//     label: string,                               // human label
//     tankCapacityL: number,                       // fuel tank, liters
//     encodeFuelByte(raw01: number): number,       // 0..1 fuel -> 0x10 byte 6
//     decodeNotes: string,                         // decode caveats
//     frameCadenceMs: { primary, service, engine, economy }, // ms overrides
//   }
//
// engine.js never hardcodes per-model byte differences: it calls
// profile.encodeFuelByte and profile.frameCadenceMs. A minimal built-in
// fallback profile for 'jupiter110' keeps the engine usable until
// profiles.js registers richer ones via engine.registerProfile().
//
// SAFETY: telemetry/display/mirroring only. No lock/unlock, immobilizer,
// ignition-cut, throttle or brake control, and no 0x9A/0xF2/0xF1 auth
// responses. The ignition toggle is the rider's physical key; the app
// cannot change it.

import {
  FRAME_SIZE,
  buildPrimary,
  buildService,
  buildEngine,
  buildEconomy,
  buildMusicButton,
  decodeOutbound,
  sanitizeNavText,
  MUSIC_COMMANDS,
  CALLER_SUB,
} from './frames.js';
import {
  createInitialPhysicsState,
  stepPhysics,
  tripAvgSpeedKph,
  tripAvgKmpl,
  dteKm,
} from './physics.js';

// Built-in fallback until W11's profiles.js registers real ones.
const FALLBACK_JUPITER_110 = {
  id: 'jupiter110',
  label: 'TVS Jupiter 110',
  tankCapacityL: 5.1, // UNVERIFIED nominal tank size; sim tuning constant
  encodeFuelByte(raw01) {
    // 110: stock passes the raw byte through. The 0..255 scale of that
    // byte is UNVERIFIED; the sim maps 0..1 linearly.
    const v = Math.round(raw01 * 255);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  },
  decodeNotes: '110: fuel byte passes through raw (Scoot provisional bars).',
  frameCadenceMs: { primary: 100, service: 5000, engine: 1000, economy: 1000 },
};

const PRESS_TO_COMMAND = {
  play: MUSIC_COMMANDS.play,
  pause: MUSIC_COMMANDS.pause,
  next: MUSIC_COMMANDS.next,
  prev: MUSIC_COMMANDS.previous,
  volup: MUSIC_COMMANDS.volumeUp,
  voldn: MUSIC_COMMANDS.volumeDown,
};

// createEngine accepts the CONTRACT.md form createEngine({ profile }),
// a bare profile id string (original W3 brief), or nothing (jupiter110).
// profile may be a registered id string or a profile object (which is
// registered on the spot).
export function createEngine(arg) {
  const registry = new Map();
  registry.set(FALLBACK_JUPITER_110.id, FALLBACK_JUPITER_110);
  let profile = FALLBACK_JUPITER_110;

  function registerProfile(p) {
    if (!p || typeof p.id !== 'string' || typeof p.encodeFuelByte !== 'function') {
      throw new Error('registerProfile: profile needs id and encodeFuelByte');
    }
    if (!p.frameCadenceMs) {
      p = { ...p, frameCadenceMs: { ...FALLBACK_JUPITER_110.frameCadenceMs } };
    }
    registry.set(p.id, p);
    return p;
  }

  function resolveProfile(p) {
    if (typeof p === 'string') return registry.get(p);
    if (p && typeof p === 'object') return registerProfile(p);
    return undefined;
  }

  function setProfile(idOrProfile) {
    const p = resolveProfile(idOrProfile);
    if (!p) {
      throw new Error(
        `unknown profile: ${idOrProfile} (known: ${[...registry.keys()].join(', ')})`,
      );
    }
    profile = p;
    return p;
  }

  if (typeof arg === 'string') {
    setProfile(arg);
  } else if (arg && typeof arg === 'object' && arg.profile !== undefined) {
    setProfile(arg.profile);
  } else if (arg != null && typeof arg === 'object' && arg.id) {
    setProfile(arg); // bare profile object
  }

  const listeners = new Map(); // event name -> Set<fn>

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // A panel listener must never break frame emission.
      }
    }
  }

  function emitFrame(bytes) {
    // Fidelity gate (W2 F3): the real cluster withholds its telemetry
    // stream until it has seen the phone's first write
    // (isFirstCyclicDataSent). 'frame' emission is held until
    // receiveFromApp() has been called at least once.
    if (!sim.firstAppWriteSeen) return;
    emit('frame', bytes);
  }

  function emitDisplay(event) {
    emit('display', event);
  }

  // Vehicle state (physics) and sim bookkeeping.
  const phys = createInitialPhysicsState({ odoKm: 1234.5, fuelLiters: 4.0 });
  const sim = {
    simTimeMs: 0,
    nextEmit: { primary: 0, service: 0, engine: 0, economy: 0 },
    serviceDirty: false,
    dtcs: [],
    serviceReminder: false,
    row1: '',
    row2: '',
    media: { title: '', artist: '', album: '' },
    caller: null,
    nav: null,
    // Fidelity gate (W2 F3): opens on the first receiveFromApp() call,
    // mirroring the real cluster's isFirstCyclicDataSent. tick() keeps
    // advancing physics regardless; only 'frame' emission is held.
    firstAppWriteSeen: false,
  };

  function fuelFraction01() {
    const cap = profile.tankCapacityL > 0 ? profile.tankCapacityL : 5.1;
    return Math.max(0, Math.min(1, phys.fuelLiters / cap));
  }

  function buildPrimaryFrame() {
    return buildPrimary({
      speedKph: phys.speedKph,
      odoKm: phys.odoKm,
      fuelByte: profile.encodeFuelByte(fuelFraction01()),
      avgSpeedKph: tripAvgSpeedKph(phys),
      ecoPowerByte: 0,
      topSpeedKph: phys.topSpeedKph,
      throttlePct: phys.throttlePct,
      ignitionOn: phys.ignitionOn,
      tripKm: phys.tripAKm,
      rpm: phys.rpm,
    });
  }

  function buildServiceFrame() {
    return buildService({
      serviceReminder: sim.serviceReminder,
      dtcCount: sim.dtcs.length,
    });
  }

  function buildEngineFrame() {
    const thr = phys.throttlePct / 100;
    return buildEngine({
      engineLoadPct: thr * 100,
      accumFuelInjectionMs: Math.round(phys.fuelBurnedLiters * 1000),
      mapKpa: 30 + thr * 70,
      intakeTempC: phys.ambientC + (phys.ignitionOn ? 5 : 0),
      engineTempC: phys.engineTempC,
      batteryV: phys.batteryV,
      runTimeS: Math.round(phys.runTimeS),
      distanceKm: phys.tripAKm,
      fuelInjectionMl: Math.round(phys.fuelBurnedLiters * 1000),
    });
  }

  function buildEconomyFrame() {
    return buildEconomy({
      avgKmpl: tripAvgKmpl(phys),
      instantKmpl: phys.instantKmpl,
      dteKm: dteKm(phys),
    });
  }

  function tick(dtMs) {
    const dt = Math.max(0, dtMs);
    sim.simTimeMs += dt;
    stepPhysics(phys, dt, {
      ignitionOn: phys.ignitionOn,
      throttlePct: phys.throttlePct,
      cruiseKph: phys.cruiseKph,
      tempOverrideC: phys.tempOverrideC,
    });

    const cad = profile.frameCadenceMs;
    const due = (key, ms) => {
      if (sim.simTimeMs >= sim.nextEmit[key]) {
        sim.nextEmit[key] = sim.simTimeMs + ms;
        return true;
      }
      return false;
    };
    if (due('primary', cad.primary)) emitFrame(buildPrimaryFrame());
    if (due('engine', cad.engine)) emitFrame(buildEngineFrame());
    if (due('economy', cad.economy)) emitFrame(buildEconomyFrame());
    // 0x11 every 5 s, and immediately on DTC change.
    if (sim.serviceDirty || due('service', cad.service)) {
      sim.serviceDirty = false;
      emitFrame(buildServiceFrame());
    }
  }

  // App -> cluster frame handling. Emits display events and the
  // CONTRACT.md named events (navtext, brightness). Never touches
  // physics or safety-gated functions.
  function receiveFromApp(bytes) {
    // Fidelity gate (W2 F3): the first call opens the 'frame' emission
    // gate and announces it once as 'linkready'.
    if (!sim.firstAppWriteSeen) {
      sim.firstAppWriteSeen = true;
      emit('linkready', { simTimeMs: sim.simTimeMs });
    }
    if (!(bytes instanceof Uint8Array) || bytes.length < FRAME_SIZE) {
      return { ok: false, known: false, reason: 'bad-frame' };
    }
    const d = decodeOutbound(bytes);
    if (!d || !d.known) return { ok: false, known: false, kind: d?.kind };
    switch (d.kind) {
      case 'mobile-data':
        emitDisplay({
          type: 'link',
          signalBars: d.signalBars,
          batteryBucket: d.batteryBucket,
          overspeedLimit: d.overspeedLimit,
          ambientTempC: d.ambientTempC,
          time: d.time,
          missedCalls: d.missedCalls,
          networkType: d.networkType,
          date: d.date,
          findMe: d.findMe,
        });
        break;
      case 'text':
        if (d.row === 1) sim.row1 = d.text;
        else sim.row2 = d.text;
        emitDisplay({ type: 'text', row1: sim.row1, row2: sim.row2 });
        break;
      case 'registration':
        emitDisplay({ type: 'registration', name: d.name });
        break;
      case 'nav-control':
        sim.nav = { ...d, active: true };
        emitDisplay({
          type: 'nav',
          distanceM: d.distanceM,
          etaMinutes: d.etaMinutes,
          remainingTripM: d.remainingTripM,
          pictogram: d.pictogram,
          rowCount: d.rowCount,
          navStatus: d.navStatus,
        });
        break;
      case 'nav-text': {
        // CONTRACT.md: navtext {text}, ASCII-sanitized, newer supersedes.
        const text = sanitizeNavText(d.text);
        emitDisplay({ type: 'nav', navText: text });
        emit('navtext', { text });
        break;
      }
      case 'caller':
        emitDisplay({
          type: 'caller',
          sub: d.sub,
          subName: d.subName,
          text: d.text,
        });
        break;
      case 'pictogram':
        emitDisplay({ type: 'pictogram', name: d.name });
        break;
      case 'media-meta':
        sim.media[d.field] = d.text;
        emitDisplay({ type: 'media', ...sim.media });
        break;
      case 'user-id':
        emitDisplay({ type: 'link', userId: d.userId });
        break;
      case 'ignored':
        if (d.ignoredId === 'vehicle-control') {
          // CONTRACT.md: brightness {level: 1..5}. Wire byte 1 -> level
          // 1, else level = wire / 2 (4,6,8,10 -> 2,3,4,5), clamped.
          // Display-only: never affects physics or frame emission.
          const wire = d.brightnessWireByte;
          const level =
            wire === 1 ? 1 : Math.max(1, Math.min(5, Math.round(wire / 2)));
          emit('brightness', { level });
        }
        // 0x73 calibration: counted as known, ignored.
        break;
      default:
        break;
    }
    return { ok: true, known: true, kind: d.kind };
  }

  function getState() {
    return {
      ignition: phys.ignitionOn,
      speedKph: phys.speedKph,
      odoKm: phys.odoKm,
      tripA: phys.tripAKm,
      tripB: phys.tripBKm,
      fuelLiters: phys.fuelLiters,
      rpm: phys.rpm,
      throttlePct: phys.throttlePct,
      batteryV: phys.batteryV,
      engineTempC: phys.engineTempC,
      dtcs: [...sim.dtcs],
      serviceReminder: sim.serviceReminder,
      profileId: profile.id,
      avgKmpl: tripAvgKmpl(phys),
      instantKmpl: phys.instantKmpl,
      dteKm: dteKm(phys),
      avgSpeedKph: tripAvgSpeedKph(phys),
      runTimeS: phys.runTimeS,
      simTimeMs: sim.simTimeMs,
      cruiseKph: phys.cruiseKph,
      row1: sim.row1,
      row2: sim.row2,
    };
  }

  const controls = {
    // The rider's physical key. The app cannot change this.
    setIgnition(on) {
      phys.ignitionOn = !!on;
    },
    setThrottle(pct) {
      phys.throttlePct = Math.max(0, Math.min(100, pct));
    },
    setCruiseKph(v) {
      phys.cruiseKph = v == null ? null : Math.max(0, v);
    },
    setFuelLiters(v) {
      phys.fuelLiters = Math.max(0, v);
    },
    // null resumes physics-driven temperature.
    setEngineTempC(v) {
      phys.tempOverrideC = v == null ? null : v;
    },
    // Sim-side only: no trip-reset frame exists in the Scoot sources
    // (PROTOCOL.md section 10 item 12), so this just resets the sim's
    // internal counters, reflected in subsequent 0x10 frames.
    resetTrip(which) {
      if (which === 'A') {
        phys.tripAKm = 0;
        phys.tripATimeS = 0;
        phys.tripAFuelL = 0;
      } else if (which === 'B') {
        phys.tripBKm = 0;
      } else {
        throw new Error(`resetTrip: expected 'A' or 'B', got ${which}`);
      }
    },
    injectDtc(code) {
      if (!sim.dtcs.includes(code)) sim.dtcs.push(code);
      sim.serviceDirty = true;
    },
    clearDtcs() {
      sim.dtcs = [];
      sim.serviceDirty = true;
    },
    pressMusicButton(name) {
      const cmd = PRESS_TO_COMMAND[name];
      if (cmd === undefined) {
        throw new Error(`pressMusicButton: unknown button ${name}`);
      }
      emitFrame(buildMusicButton(cmd));
    },
    // Sim-side helpers so the webapp can preview cluster call/SMS UI.
    // The real caller/SMS bytes travel app -> cluster; these only drive
    // the sim's display events.
    incomingCall({ name, number } = {}) {
      sim.caller = { name: name ?? '', number: number ?? '' };
      emitDisplay({ type: 'caller', direction: 'incoming', ...sim.caller });
    },
    endCall() {
      sim.caller = null;
      emitDisplay({ type: 'caller', direction: 'ended' });
    },
    incomingSms({ sender, text } = {}) {
      emitDisplay({
        type: 'text',
        row1: String(sender ?? '').slice(0, 17),
        row2: String(text ?? '').slice(0, 17),
        source: 'sms',
      });
    },
    routeStart(waypoints = [], opts = {}) {
      sim.nav = { waypoints, opts, active: true };
      emitDisplay({ type: 'nav', status: 'route-started', waypoints, opts });
    },
    routeStop() {
      sim.nav = null;
      emitDisplay({ type: 'nav', status: 'route-stopped' });
    },
  };

  // W8 deck-name aliases onto the real controls. The originals above stay
  // untouched; the deck calls these short names.
  controls.setKey = controls.setIgnition;
  controls.setFuel = controls.setFuelLiters;
  controls.setCruise = controls.setCruiseKph;
  controls.clearCruise = () => controls.setCruiseKph(null);
  controls.injectDTC = controls.injectDtc;
  controls.clearDTCs = controls.clearDtcs;
  controls.setEngineTempOverride = controls.setEngineTempC;
  controls.clearEngineTempOverride = () => controls.setEngineTempC(null);

  return {
    on,
    off,
    receiveFromApp,
    tick,
    getState,
    setProfile,
    registerProfile,
    controls,
  };
}

// Re-exported for tests and for W11's profiles.js.
export { CALLER_SUB };
