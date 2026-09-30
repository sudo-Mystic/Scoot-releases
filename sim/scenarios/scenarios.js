// Scripted test rides for the Scoot scooter simulator.
//
// A scenario is plain data:
//   { id, title, description, steps: [{ atMs, action, args }] }
// where `action` names a method on engine.controls and `args` is the
// positional argument list for that method. The runner drives steps by
// elapsed time from its tick() clock, which the sim main loop calls.
//
// Contract assumed for engine.controls (agreed with the engine worker):
//   setIgnition(on: boolean)
//   setThrottle(0.0 .. 1.0)
//   setCruiseKph(kph: number | null)   // null disengages cruise
//   injectDtc(code: string)            // e.g. 'P0107'
//   clearDtcs()
//   incomingCall(name: string, number: string)
//   endCall()
//   incomingSms(sender: string, text: string)
//   pressMusicButton(button: 'play' | 'pause' | 'next' | 'prev')
//   resetTrip()
//   setFuelLiters(liters: number)
//
// Safety: scenarios only use these safe controls. No auth frames, no
// control commands, no secrets. Determinism: throttle profiles are
// generated with a seeded PRNG (mulberry32) at module load. No
// Math.random, no Date.now anywhere in this file. The runner takes its
// clock from tick(nowMs), so a run is reproducible tick for tick.

'use strict';

// Deterministic PRNG. Same seed always yields the same sequence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function r2(x) {
  return Math.round(x * 100) / 100;
}

function step(atMs, action, args) {
  return { atMs: Math.round(atMs), action, args: args || [] };
}

// (a) City commute: key on, stop-and-go traffic, about 2 minutes.
// A 5 minute commute compressed into roughly 2 minutes of script.
function buildCityCommute() {
  const rand = mulberry32(20260930);
  const steps = [step(0, 'setIgnition', [true])];
  let t = 2000;
  const cycles = 8;
  for (let i = 0; i < cycles; i++) {
    const peak = 0.45 + rand() * 0.2; // 0.45 to 0.65
    const cruiseMs = 3000 + Math.floor(rand() * 3000); // 3 to 6 s rolling
    const slowMs = 2000 + Math.floor(rand() * 2000); // 2 to 4 s slowing
    const stopMs = 3000 + Math.floor(rand() * 4000); // 3 to 7 s at a standstill
    steps.push(step(t, 'setThrottle', [r2(peak)]));
    t += 1500;
    steps.push(step(t, 'setThrottle', [r2(peak * 0.6)]));
    t += cruiseMs;
    steps.push(step(t, 'setThrottle', [0.15]));
    t += slowMs;
    steps.push(step(t, 'setThrottle', [0])); // stopped, e.g. at a signal
    t += stopMs;
  }
  steps.push(step(t, 'setThrottle', [0]));
  steps.push(step(t + 2000, 'setIgnition', [false]));
  return steps;
}

// (b) Highway run: cruise control at 70 kph for 3 minutes.
function buildHighwayRun() {
  return [
    step(0, 'setIgnition', [true]),
    step(1000, 'setThrottle', [0.7]),
    step(12000, 'setCruiseKph', [70]),
    step(13000, 'setThrottle', [0.05]), // cruise holds the speed now
    step(60000, 'setThrottle', [0.25]), // gentle overtake
    step(64000, 'setThrottle', [0.05]),
    step(120000, 'setCruiseKph', [75]), // nudge the set speed up
    step(170000, 'setCruiseKph', [null]), // disengage
    step(171000, 'setThrottle', [0]),
    step(178000, 'setIgnition', [false]),
  ];
}

// (c) Fault injection: a check-engine DTC appears mid-ride, then is cleared.
function buildFaultInjection() {
  return [
    step(0, 'setIgnition', [true]),
    step(1000, 'setThrottle', [0.5]),
    step(25000, 'injectDtc', ['P0107']), // check engine light on
    step(45000, 'clearDtcs', []), // fault cleared
    step(60000, 'setThrottle', [0]),
    step(65000, 'setIgnition', [false]),
  ];
}

// (d) Call during nav: an incoming call arrives while cruise is active.
function buildCallDuringNav() {
  return [
    step(0, 'setIgnition', [true]),
    step(2000, 'setThrottle', [0.6]),
    step(15000, 'setCruiseKph', [60]),
    step(16000, 'setThrottle', [0.05]),
    step(50000, 'incomingCall', ['Mom', '98765 43210']),
    step(75000, 'endCall', []),
    step(100000, 'setCruiseKph', [null]),
    step(101000, 'setThrottle', [0]),
    step(110000, 'setIgnition', [false]),
  ];
}

// (e) Low fuel warning: fuel drops to reserve level mid-ride.
function buildLowFuelWarning() {
  return [
    step(0, 'setIgnition', [true]),
    step(1000, 'setFuelLiters', [4.2]),
    step(2000, 'setThrottle', [0.5]),
    step(30000, 'setFuelLiters', [0.9]), // reserve warning should fire
    step(60000, 'setThrottle', [0]),
    step(65000, 'setIgnition', [false]),
  ];
}

export const SCENARIOS = [
  {
    id: 'city-commute',
    title: 'City commute',
    description:
      'Key on and stop-and-go riding through traffic signals, about 2 minutes. Exercises throttle changes, trip recording and the idle state.',
    steps: buildCityCommute(),
  },
  {
    id: 'highway-run',
    title: 'Highway run',
    description:
      'Cruise control set to 70 kph for 3 minutes, with a gentle overtake in the middle. Tests cruise engage, hold and disengage.',
    steps: buildHighwayRun(),
  },
  {
    id: 'fault-injection',
    title: 'Fault injection',
    description:
      'A check-engine fault (P0107) is injected mid-ride and cleared 20 seconds later. Tests the malfunction indicator and DTC clear path.',
    steps: buildFaultInjection(),
  },
  {
    id: 'call-during-nav',
    title: 'Call during nav',
    description:
      'An incoming call arrives while cruise is active, then ends. Tests call alerts on the cluster without disturbing the ride.',
    steps: buildCallDuringNav(),
  },
  {
    id: 'low-fuel-warning',
    title: 'Low fuel warning',
    description:
      'Fuel drops to reserve level (0.9 L) mid-ride. Tests the low fuel warning on the cluster.',
    steps: buildLowFuelWarning(),
  },
];

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

// Runner: executes a scenario's steps against engine.controls.
// Driven by tick(nowMs) from the sim main loop. Emits events:
//   'start'    { scenario }
//   'step'     { step, index }
//   'progress' { elapsedMs, totalMs, stepsDone, stepsTotal }
//   'error'    { step, index, error }  (runner keeps going)
//   'done'     { scenario, errors }
export function createRunner() {
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
        console.error('[scenarios] handler for "' + event + '" threw:', err);
      }
    }
  }

  function start(scenario, engine) {
    if (!scenario || !Array.isArray(scenario.steps)) {
      throw new Error('scenarios: start() needs a scenario with a steps array');
    }
    if (!engine || !engine.controls) {
      throw new Error('scenarios: engine.controls is missing');
    }
    const unknown = [...new Set(scenario.steps.map((s) => s.action))].filter(
      (a) => typeof engine.controls[a] !== 'function'
    );
    if (unknown.length) {
      throw new Error('scenarios: unknown control action(s): ' + unknown.join(', '));
    }
    if (active) stop();
    // Work on a time-sorted copy so out-of-order steps still fire deterministically.
    const steps = scenario.steps
      .map((s, i) => ({ atMs: s.atMs, action: s.action, args: s.args || [], _i: i }))
      .sort((a, b) => a.atMs - b.atMs || a._i - b._i);
    active = {
      scenario,
      engine,
      steps,
      t0: null,
      idx: 0,
      errors: [],
      totalMs: steps.length ? steps[steps.length - 1].atMs : 0,
    };
    emit('start', { scenario });
    return api;
  }

  function progressSnapshot() {
    if (!active) return null;
    const elapsed = active.t0 === null ? 0 : active._lastNow - active.t0;
    return {
      elapsedMs: Math.max(0, Math.round(elapsed)),
      totalMs: active.totalMs,
      stepsDone: active.idx,
      stepsTotal: active.steps.length,
    };
  }

  function tick(nowMs) {
    if (!active) return;
    if (active.t0 === null) active.t0 = nowMs;
    active._lastNow = nowMs;
    const elapsed = nowMs - active.t0;
    while (active.idx < active.steps.length && active.steps[active.idx].atMs <= elapsed) {
      const index = active.idx;
      const st = active.steps[index];
      try {
        active.engine.controls[st.action](...st.args);
      } catch (err) {
        const record = {
          step: { atMs: st.atMs, action: st.action, args: st.args },
          index,
          error: String((err && err.message) || err),
        };
        active.errors.push(record);
        emit('error', record);
      }
      active.idx += 1;
      emit('step', { step: { atMs: st.atMs, action: st.action, args: st.args }, index });
    }
    emit('progress', progressSnapshot());
    if (active.idx >= active.steps.length) {
      const done = { scenario: active.scenario, errors: active.errors };
      active = null;
      emit('done', done);
    }
  }

  function stop() {
    if (!active) return false;
    const scenario = active.scenario;
    active = null;
    emit('stop', { scenario });
    return true;
  }

  function isRunning() {
    return active !== null;
  }

  const api = { start, stop, tick, on, off, isRunning, progress: progressSnapshot };
  return api;
}
