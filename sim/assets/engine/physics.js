// Pure scooter physics for the Scoot simulator. Zero dependencies, no DOM.
// Mutates the passed state object in place and returns it.

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// UNVERIFIED sim tuning constants: top speed, fuel rates, thermal time
// constants. Chosen to feel like a 110cc scooter, not measured.
export function createInitialPhysicsState(overrides = {}) {
  return {
    ignitionOn: false,
    speedKph: 0,
    odoKm: 0,
    tripAKm: 0,
    tripBKm: 0,
    fuelLiters: 4.0,
    fuelBurnedLiters: 0,
    rpm: 0,
    throttlePct: 0,
    batteryV: 12.6,
    engineTempC: 30,
    ambientC: 30,
    tempOverrideC: null,
    cruiseKph: null,
    maxSpeedKph: 95,
    runTimeS: 0,
    tripATimeS: 0,
    tripAFuelL: 0,
    topSpeedKph: 0,
    instantKmpl: 0,
    ...overrides,
  };
}

// Advance the vehicle model by dtMs. inputs: { ignitionOn, throttlePct,
// cruiseKph, tempOverrideC }. Missing inputs keep current state.
export function stepPhysics(s, dtMs, inputs = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  if (dt === 0) return s;

  const ignition = inputs.ignitionOn !== undefined ? !!inputs.ignitionOn : s.ignitionOn;
  s.ignitionOn = ignition;
  const thrRaw = inputs.throttlePct !== undefined ? inputs.throttlePct : s.throttlePct;
  const thr = ignition ? clamp(thrRaw, 0, 100) / 100 : 0;
  s.throttlePct = ignition ? clamp(thrRaw, 0, 100) : 0;

  if (inputs.cruiseKph !== undefined) s.cruiseKph = inputs.cruiseKph;
  const cruise = s.cruiseKph;
  const target = !ignition
    ? 0
    : cruise != null
      ? clamp(cruise, 0, s.maxSpeedKph)
      : thr * s.maxSpeedKph;

  // Speed follows target with separate accel / coast time constants.
  const tau = target > s.speedKph ? 2.2 : 7.0;
  s.speedKph += (target - s.speedKph) * (1 - Math.exp(-dt / tau));
  if (target === 0 && s.speedKph < 0.05) s.speedKph = 0;

  const distKm = (s.speedKph * dt) / 3600;
  s.odoKm += distKm;
  s.tripAKm += distKm;
  s.tripBKm += distKm;

  // Fuel burn proportional to throttle and load.
  const idleLps = ignition ? 0.00004 : 0;
  const loadLps = thr * 0.0008 * (0.5 + 0.5 * (s.speedKph / s.maxSpeedKph));
  const burnLps = idleLps + loadLps;
  const burned = burnLps * dt;
  s.fuelLiters = Math.max(0, s.fuelLiters - burned);
  s.fuelBurnedLiters += burned;

  s.instantKmpl =
    s.speedKph > 1 && burnLps > 0 ? s.speedKph / 3600 / burnLps : 0;

  // RPM derived from speed and throttle; 1400 idle, ~7500 at full chat.
  s.rpm = ignition
    ? Math.round(
        1400 + (s.speedKph / s.maxSpeedKph) * 6100 * (0.55 + 0.45 * thr),
      )
    : 0;

  // Battery sags under load while running, recovers toward charge
  // voltage; decays slowly toward rest voltage when off.
  const battTarget = ignition ? 13.4 - thr * 0.7 : 12.4;
  s.batteryV += (battTarget - s.batteryV) * (1 - Math.exp(-dt / 20));

  // Engine temp warms toward ~90 C running, cools to ambient when off.
  if (inputs.tempOverrideC !== undefined) s.tempOverrideC = inputs.tempOverrideC;
  if (s.tempOverrideC != null) {
    s.engineTempC = s.tempOverrideC;
  } else {
    const tTarget = ignition ? 90 : s.ambientC;
    const tTau = ignition ? 120 : 600;
    s.engineTempC += (tTarget - s.engineTempC) * (1 - Math.exp(-dt / tTau));
  }

  if (ignition) s.runTimeS += dt;
  s.tripATimeS += dt;
  s.tripAFuelL += burned;
  if (s.speedKph > s.topSpeedKph) s.topSpeedKph = s.speedKph;

  return s;
}

// Trip-A average speed, km/h.
export function tripAvgSpeedKph(s) {
  return s.tripATimeS > 0 ? s.tripAKm / (s.tripATimeS / 3600) : 0;
}

// Trip-A average fuel economy, km/L.
export function tripAvgKmpl(s) {
  return s.tripAFuelL > 0 ? s.tripAKm / s.tripAFuelL : 0;
}

// Distance to empty, km: remaining fuel times trip average economy.
export function dteKm(s) {
  const avg = tripAvgKmpl(s);
  return s.fuelLiters * (avg > 0 ? avg : 45);
}
