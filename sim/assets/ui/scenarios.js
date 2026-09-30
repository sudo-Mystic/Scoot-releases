// Test scenarios panel for the Scoot scooter simulator cockpit.
//
// mount(rootEl, ctx) builds:
//   - a list of scripted test rides with Run / Stop and a progress bar
//   - a frame recording section (record toggle + JSONL download)
//   - a replay section (pick a recording file, feed it back at original timing)
//
// ctx = { engine, mainLoop? }
//   engine:   the simulator engine (engine.controls + 'frame' events +
//            engine.receiveFromApp for replay). If missing, controls are
//            disabled and the panel explains why.
//   mainLoop: optional { add(fn), remove(fn) } shared tick source. When
//            absent, the panel runs its own requestAnimationFrame pump.
//
// Plain-language labels. No emojis. This is the only file of the three
// that touches the DOM.

import { SCENARIOS, createRunner } from '../scenarios/scenarios.js';
import {
  createRecorder,
  createReplayer,
  parseRecording,
  recordingStats,
} from '../scenarios/recorder.js';

const CSS = `
.sim-scen { font-family: var(--font-ui); color: var(--text); font-size: 13px; }
.sim-scen h2 { font-size: 15px; margin: 0 0 4px; color: var(--text); }
.sim-scen h3 { font-size: 13px; margin: 0 0 4px; color: var(--text); }
.sim-scen p { margin: 0 0 8px; color: var(--text-dim); line-height: 1.45; }
/* DENSITY 9: sections are separated by 1px dividers, not nested card boxes */
.sim-scen .card { padding: 12px 0; margin: 0; }
.sim-scen .card + .card { border-top: 1px solid var(--line); }
.sim-scen .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sim-scen .grow { flex: 1 1 auto; min-width: 160px; }
.sim-scen button {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; cursor: pointer; min-height: 32px;
  background: var(--bg-raise); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: var(--radius);
  padding: 7px 12px;
}
.sim-scen button:hover:not(:disabled) { border-color: var(--accent-dim); }
.sim-scen button:active:not(:disabled) { transform: scale(0.98); }
.sim-scen button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sim-scen button:disabled { opacity: 0.45; cursor: default; }
.sim-scen button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
.sim-scen button.danger { border-color: var(--bad); color: var(--bad); }
.sim-scen .bar { height: 8px; background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; margin: 8px 0 4px; }
.sim-scen .bar > div { height: 100%; width: 0%; background: var(--accent); transition: width 120ms linear; }
.sim-scen .status { color: var(--text-dim); font-size: 12px; min-height: 18px; }
.sim-scen .status.ok { color: var(--ok); }
.sim-scen .status.warn { color: var(--warn); }
.sim-scen .status.bad { color: var(--bad); }
.sim-scen .meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); }
.sim-scen input[type="file"] { color: var(--text-dim); font-size: 12px; max-width: 100%; min-height: 32px; }
.sim-scen .scen-title { display: flex; align-items: baseline; gap: 8px; }
@media (max-width: 767px) {
  .sim-scen button { min-height: 40px; }
  .sim-scen input[type="file"] { min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .sim-scen .bar > div { transition: none; }
}
`;

function fmtSecs(ms) {
  return Math.round(ms / 1000) + 's';
}

function stampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    'scoot-sim-frames-' +
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
    '.jsonl'
  );
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mount(rootEl, ctx) {
  ctx = ctx || {};
  const engine = ctx.engine || null;
  const runner = createRunner();
  const recorder = createRecorder();
  const replayer = createReplayer();

  const root = el('div', 'sim-scen');
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const engineMissing = !engine || !engine.controls;

  // ---------- header ----------
  const head = el('div', 'card');
  head.appendChild(el('h2', null, 'Test rides'));
  head.appendChild(
    el(
      'p',
      null,
      engineMissing
        ? 'The simulator engine is not connected yet, so the controls below are disabled.'
        : 'Run a scripted ride on the simulated scooter. Scripts only use the same safe controls you can use by hand: ignition, throttle, cruise, fault injection, calls, SMS, music buttons, trip reset and fuel level.'
    )
  );
  root.appendChild(head);

  // ---------- scenario list ----------
  // (The shell panel-head already labels this panel "Scenarios", so no
  // redundant inner heading here.)
  const listCard = el('div', 'card');
  const scenRows = [];
  const listStatus = el('div', 'status');
  listStatus.setAttribute('aria-live', 'polite');

  SCENARIOS.forEach((sc) => {
    const row = el('div', 'card');
    const titleRow = el('div', 'row');
    const titleBox = el('div', 'grow');
    const titleLine = el('div', 'scen-title');
    titleLine.appendChild(el('h3', null, sc.title));
    titleLine.appendChild(el('span', 'meta', fmtSecs(lastStepMs(sc)) + ' script'));
    titleBox.appendChild(titleLine);
    titleBox.appendChild(el('p', null, sc.description));
    titleRow.appendChild(titleBox);

    const runBtn = el('button', 'primary', 'Run');
    const stopBtn = el('button', 'danger', 'Stop');
    stopBtn.style.display = 'none';
    titleRow.appendChild(runBtn);
    titleRow.appendChild(stopBtn);
    row.appendChild(titleRow);

    const bar = el('div', 'bar');
    const fill = el('div');
    bar.appendChild(fill);
    bar.style.display = 'none';
    const prog = el('div', 'status');
    prog.style.display = 'none';
    row.appendChild(bar);
    row.appendChild(prog);
    listCard.appendChild(row);

    runBtn.disabled = engineMissing;
    runBtn.addEventListener('click', () => {
      try {
        runner.start(sc, engine);
      } catch (err) {
        setStatus(listStatus, 'bad', 'Could not start: ' + err.message);
      }
    });
    stopBtn.addEventListener('click', () => runner.stop());
    scenRows.push({ sc, runBtn, stopBtn, bar, fill, prog });
  });
  listCard.appendChild(listStatus);
  root.appendChild(listCard);

  function lastStepMs(sc) {
    return sc.steps.length ? sc.steps[sc.steps.length - 1].atMs : 0;
  }

  function setStatus(node, kind, text) {
    node.className = 'status' + (kind ? ' ' + kind : '');
    node.textContent = text;
  }

  function refreshScenarioButtons(runningId) {
    scenRows.forEach((r) => {
      const isThis = r.sc.id === runningId;
      r.runBtn.style.display = isThis ? 'none' : '';
      r.stopBtn.style.display = isThis ? '' : 'none';
      r.runBtn.disabled = engineMissing || (runningId !== null && !isThis);
      r.bar.style.display = isThis ? '' : 'none';
      r.prog.style.display = isThis ? '' : 'none';
      if (!isThis) {
        r.fill.style.width = '0%';
        r.prog.textContent = '';
      }
    });
  }

  runner.on('start', ({ scenario }) => {
    refreshScenarioButtons(scenario.id);
    setStatus(listStatus, '', 'Running: ' + scenario.title);
  });
  runner.on('progress', (p) => {
    const r = scenRows.find((x) => runner.isRunning() && x.sc.id === currentId());
    if (!r) return;
    const pct = p.totalMs ? Math.min(100, (p.elapsedMs / p.totalMs) * 100) : 100;
    r.fill.style.width = pct.toFixed(1) + '%';
    r.prog.textContent =
      'Step ' + p.stepsDone + ' of ' + p.stepsTotal + ', ' +
      fmtSecs(p.elapsedMs) + ' of ' + fmtSecs(p.totalMs);
  });
  runner.on('error', ({ step, error }) => {
    setStatus(listStatus, 'warn', 'A script step failed (' + step.action + '): ' + error + '. Continuing.');
  });
  const finishRun = (msg, kind) => {
    refreshScenarioButtons(null);
    setStatus(listStatus, kind || 'ok', msg);
  };
  runner.on('done', ({ scenario, errors }) => {
    finishRun(
      errors.length
        ? 'Finished: ' + scenario.title + ' (' + errors.length + ' steps had errors).'
        : 'Finished: ' + scenario.title,
      errors.length ? 'warn' : 'ok'
    );
  });
  runner.on('stop', ({ scenario }) => finishRun('Stopped: ' + scenario.title));

  function currentId() {
    const r = scenRows.find((x) => x.stopBtn.style.display !== 'none');
    return r ? r.sc.id : null;
  }

  // ---------- recording ----------
  const recCard = el('div', 'card');
  recCard.appendChild(el('h3', null, 'Record frames'));
  recCard.appendChild(
    el(
      'p',
      null,
      'Record every frame the simulator exchanges with the app, saved as a JSONL file. Each line holds the time, the direction (in or out) and the frame bytes as hex.'
    )
  );
  const recRow = el('div', 'row');
  const recBtn = el('button', 'primary', 'Start recording');
  const dlBtn = el('button', null, 'Download recording');
  dlBtn.disabled = true;
  const recStatus = el('div', 'status');
  recStatus.setAttribute('aria-live', 'polite');
  recRow.appendChild(recBtn);
  recRow.appendChild(dlBtn);
  recCard.appendChild(recRow);
  recCard.appendChild(recStatus);
  root.appendChild(recCard);

  recBtn.disabled = engineMissing;
  let lastRecordingText = '';
  let lastRecFrameCount = 0;

  recBtn.addEventListener('click', () => {
    if (recorder.isRecording()) {
      const summary = recorder.stop();
      lastRecordingText = recorder.getJsonl();
      lastRecFrameCount = 0;
      recBtn.textContent = 'Start recording';
      dlBtn.disabled = !lastRecordingText;
      setStatus(
        recStatus,
        'ok',
        'Recording stopped: ' + summary.frames + ' frames over ' + fmtSecs(summary.durationMs) + '.'
      );
      return;
    }
    try {
      lastRecordingText = '';
      recorder.start(engine);
      recBtn.textContent = 'Stop recording';
      recBtn.classList.remove('primary');
      recBtn.classList.add('danger');
      dlBtn.disabled = true;
      setStatus(recStatus, '', 'Recording frames...');
      ensurePump();
    } catch (err) {
      setStatus(recStatus, 'bad', 'Could not start recording: ' + err.message);
    }
  });

  dlBtn.addEventListener('click', () => {
    if (!lastRecordingText) return;
    const blob = new Blob([lastRecordingText], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = stampName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(recStatus, 'ok', 'Recording downloaded.');
  });

  function updateRecordingStatus() {
    if (!recorder.isRecording()) return;
    const n = recorder.frameCount();
    if (n !== lastRecFrameCount) {
      lastRecFrameCount = n;
      setStatus(recStatus, '', 'Recording frames... ' + n + ' captured so far.');
    }
  }

  // ---------- replay ----------
  const repCard = el('div', 'card');
  repCard.appendChild(el('h3', null, 'Replay a recording'));
  repCard.appendChild(
    el(
      'p',
      null,
      'Pick a recording file to send its app-to-simulator frames back through the simulator at the original timing. Simulator-to-app frames in the file are skipped.'
    )
  );
  const repRow = el('div', 'row');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.jsonl,application/jsonl';
  fileInput.setAttribute('aria-label', 'Recording file to replay');
  const repBtn = el('button', 'primary', 'Start replay');
  repBtn.disabled = true;
  const repStop = el('button', 'danger', 'Stop replay');
  repStop.style.display = 'none';
  repRow.appendChild(fileInput);
  repRow.appendChild(repBtn);
  repRow.appendChild(repStop);
  repCard.appendChild(repRow);
  const repBar = el('div', 'bar');
  const repFill = el('div');
  repBar.appendChild(repFill);
  repBar.style.display = 'none';
  const repStatus = el('div', 'status');
  repStatus.setAttribute('aria-live', 'polite');
  repCard.appendChild(repBar);
  repCard.appendChild(repStatus);
  root.appendChild(repCard);

  let pendingFrames = null;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    repBtn.disabled = true;
    pendingFrames = null;
    if (!file) {
      setStatus(repStatus, '', '');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { frames, skipped } = parseRecording(reader.result);
        const stats = recordingStats(frames);
        pendingFrames = frames;
        const note = skipped.length ? ' ' + skipped.length + ' bad lines skipped.' : '';
        setStatus(
          repStatus,
          stats.inbound ? '' : 'warn',
          'Loaded ' + stats.total + ' frames (' + stats.inbound + ' from the app, ' +
            stats.outbound + ' from the simulator), ' + fmtSecs(stats.durationMs) + ' long.' + note
        );
        repBtn.disabled = engineMissing || !stats.inbound;
        if (!stats.inbound) {
          setStatus(repStatus, 'warn', 'No app-to-simulator frames in this file, nothing to replay.' + note);
        }
      } catch (err) {
        setStatus(repStatus, 'bad', 'Could not read that file: ' + err.message);
      }
    };
    reader.onerror = () => setStatus(repStatus, 'bad', 'Could not read that file.');
    reader.readAsText(file);
  });

  repBtn.addEventListener('click', () => {
    if (!pendingFrames) return;
    try {
      replayer.start(engine, pendingFrames);
      repBtn.style.display = 'none';
      repStop.style.display = '';
      repBar.style.display = '';
      repFill.style.width = '0%';
      setStatus(repStatus, '', 'Replaying...');
      ensurePump();
    } catch (err) {
      setStatus(repStatus, 'bad', 'Could not start replay: ' + err.message);
    }
  });
  repStop.addEventListener('click', () => replayer.stop());

  replayer.on('progress', (p) => {
    const pct = p.total ? Math.min(100, (p.fed / p.total) * 100) : 100;
    repFill.style.width = pct.toFixed(1) + '%';
    setStatus(repStatus, '', 'Replaying: fed ' + p.fed + ' of ' + p.total + ' frames.');
  });
  replayer.on('error', ({ error }) => {
    setStatus(repStatus, 'warn', 'A replayed frame was rejected: ' + error + '. Continuing.');
  });
  const repIdle = () => {
    repBtn.style.display = '';
    repStop.style.display = 'none';
    repBtn.disabled = engineMissing || !pendingFrames;
  };
  replayer.on('done', ({ fed, total, errors, ignoredOut }) => {
    repIdle();
    setStatus(
      repStatus,
      errors.length ? 'warn' : 'ok',
      'Replay finished: fed ' + fed + ' of ' + total + ' app frames' +
        (ignoredOut ? ' (' + ignoredOut + ' simulator frames skipped)' : '') +
        (errors.length ? ', ' + errors.length + ' rejected.' : '.')
    );
  });
  replayer.on('stop', () => {
    repIdle();
    setStatus(repStatus, '', 'Replay stopped.');
  });

  // ---------- tick wiring ----------
  function tickAll(ts) {
    runner.tick(ts);
    replayer.tick(ts);
    updateRecordingStatus();
  }

  let pumpOn = false;
  let rafId = 0;
  let detachMain = null;
  if (ctx.mainLoop && typeof ctx.mainLoop.add === 'function') {
    const maybeUnsub = ctx.mainLoop.add(tickAll);
    if (typeof maybeUnsub === 'function') detachMain = maybeUnsub;
  }

  function pump(ts) {
    if (!pumpOn) return;
    tickAll(ts);
    if (runner.isRunning() || replayer.isReplaying() || recorder.isRecording()) {
      rafId = requestAnimationFrame(pump);
    } else {
      pumpOn = false;
    }
  }

  function ensurePump() {
    if (detachMain) return; // main loop drives ticks
    if (pumpOn) return;
    pumpOn = true;
    rafId = requestAnimationFrame(pump);
  }

  function unmount() {
    try { runner.stop(); } catch (e) {}
    try { replayer.stop(); } catch (e) {}
    try { if (recorder.isRecording()) recorder.stop(); } catch (e) {}
    pumpOn = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (detachMain) {
      try { detachMain(); } catch (e) {}
    } else if (ctx.mainLoop && typeof ctx.mainLoop.remove === 'function') {
      try { ctx.mainLoop.remove(tickAll); } catch (e) {}
    }
    root.remove();
  }

  rootEl.appendChild(root);
  return { unmount, runner, recorder, replayer };
}
