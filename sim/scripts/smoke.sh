#!/usr/bin/env bash
# Scoot simulator smoke test (W15 integration gate), bridge world.
#
# Gates:
#   1. npm ci + vite build in sim/; dist self-contained with relative paths
#   2. node --test on src/engine/*.test.js and tests/*.test.js, all green
#   3. bridge WS layer: start `python3 sim/bridge/jupiter-ble-bridge.py
#      --no-ble`, assert /health 200, run sim/bridge/smoke_local.py
#   4. full loopback: a node WS client joins as the sim client, sends a
#      20-byte 0x5A frame, and asserts the bridge accepts it without an
#      error frame (the bridge does NOT echo binary frames back to the
#      webapp; they are queued for BLE notify, which needs real
#      hardware). The hardware hop is verified by
#      sim/bridge/verify_bridge.py (bleak) on the user's machine.
#
# Env overrides:
#   BRIDGE_PORT   port the bridge listens on for gates 3-4 (default 18765)

set -euo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_PORT="${BRIDGE_PORT:-18765}"
PASS=0
FAIL=0

step() { echo "==> $*"; }
ok()   { PASS=$((PASS+1)); echo "    PASS: $*"; }
die()  { FAIL=$((FAIL+1)); echo "    FAIL: $*" >&2; exit 1; }

cleanup_bridge() {
  if [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup_bridge EXIT

# ---------------------------------------------------------------- 1. build
step "[1/4] building webapp (npm ci + vite build)"
cd "$SIM_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  echo "    note: no package-lock.json, using npm install"
  npm install --no-audit --no-fund
fi
npm run build

# ---------------------------------------------- 1b. dist relative-path check
step "[1b/4] checking dist/index.html asset paths"
[[ -f dist/index.html ]] || die "dist/index.html missing after build"
if grep -Eq '(src|href)="/' dist/index.html; then
  die "dist/index.html contains root-absolute asset paths (breaks /sim/ on Pages)"
fi
if grep -Eq '(src|href)="https?://' dist/index.html; then
  echo "    note: dist/index.html references absolute http(s) URLs (check they are intentional)"
fi
grep -Eq '(src|href)="\./assets/' dist/index.html \
  || die "dist/index.html has no relative ./assets references"
ok "dist/index.html exists with relative asset paths"

# ------------------------------------------------------------------ 2. tests
step "[2/4] running node test suites"
shopt -s nullglob
test_files=(src/engine/*.test.js tests/*.test.js)
shopt -u nullglob
if [[ ${#test_files[@]} -eq 0 ]]; then
  die "no test files found (src/engine/*.test.js or tests/*.test.js)"
fi
echo "    test files: ${test_files[*]}"
node --test "${test_files[@]}" || die "node --test failed"
ok "all node tests passed (${#test_files[@]} files)"

# ------------------------------------------------- 3. bridge WS layer
step "[3/4] bridge WS layer (--no-ble, /health, smoke_local.py)"
cd "$SIM_DIR/bridge"
if ! python3 -c "import websockets" >/dev/null 2>&1; then
  echo "    installing bridge python deps (websockets)"
  if ! pip install -q -r requirements.txt >/dev/null 2>&1; then
    pip install -q --break-system-packages -r requirements.txt \
      || die "could not install bridge requirements (pip install -r requirements.txt)"
  fi
fi
python3 -c "import websockets" >/dev/null 2>&1 \
  || die "python websockets module still unavailable"

python3 jupiter-ble-bridge.py --no-ble --port "$BRIDGE_PORT" \
  >/tmp/smoke-bridge.log 2>&1 &
BRIDGE_PID=$!
echo "    bridge pid $BRIDGE_PID on port $BRIDGE_PORT"

healthy=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
    healthy=1; break
  fi
  kill -0 "$BRIDGE_PID" 2>/dev/null || die "bridge exited during startup (see /tmp/smoke-bridge.log)"
  sleep 0.5
done
[[ $healthy -eq 1 ]] || die "/health never returned 200 on port $BRIDGE_PORT (see /tmp/smoke-bridge.log)"
echo "    /health body: $(curl -s "http://127.0.0.1:${BRIDGE_PORT}/health")"
ok "bridge /health 200 on port $BRIDGE_PORT"

python3 smoke_local.py || die "smoke_local.py failed"
ok "smoke_local.py passed (join/joined, 20-byte accept, 19-byte reject, /health, auth drop, client replace)"

# ------------------------------------------------- 4. WS loopback
step "[4/4] WS loopback: join as sim client, send 20-byte 0x5A frame"
node --input-type=module -e '
const WS_URL = process.argv[1];

// 20-byte 0x5A-lead frame, as the sim emits (cluster -> phone direction).
const frame = new Uint8Array(20);
frame[0] = 0x5a; frame[1] = 0x10; frame[2] = 42; frame[19] = 0xff;

const fail = (m) => { console.error("    FAIL: " + m); process.exit(1); };

function recvJson(ws, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + " timeout")), timeoutMs);
    const h = (ev) => {
      if (typeof ev.data !== "string") return; // binary is BLE-bound; ignore here
      clearTimeout(t);
      ws.removeEventListener("message", h);
      try { resolve(JSON.parse(ev.data)); }
      catch (e) { reject(new Error(label + ": bad JSON")); }
    };
    ws.addEventListener("message", h);
  });
}

function expectNoErrorFrame(ws, waitMs) {
  // The bridge never echoes binary back to the webapp (frames are queued
  // for BLE notify); the strongest WS-side assertion is that a valid
  // 20-byte frame is accepted WITHOUT a {"t":"error",...} response and
  // the socket stays open. BLE delivery is the hardware step
  // (verify_bridge.py on a BLE adapter).
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.removeEventListener("message", h); resolve(); }, waitMs);
    const h = (ev) => {
      if (typeof ev.data !== "string") return;
      let m = null;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.t === "error") {
        clearTimeout(t);
        ws.removeEventListener("message", h);
        reject(new Error("bridge rejected the 20-byte 0x5A frame: " + m.msg));
      }
    };
    ws.addEventListener("message", h);
  });
}

try {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); });
  });

  ws.send(JSON.stringify({ t: "join", role: "sim" }));
  const joined = await recvJson(ws, 5000, "joined");
  if (joined.t !== "joined") fail("expected {t:joined}, got " + JSON.stringify(joined));
  console.log("    join/joined handshake OK");
  const ble = await recvJson(ws, 5000, "ble state");
  if (ble.t !== "ble" || typeof ble.connected !== "boolean") {
    fail("expected {t:ble, connected:bool}, got " + JSON.stringify(ble));
  }
  console.log("    {t:ble, connected:" + ble.connected + "} shape OK");

  ws.send(frame);
  await expectNoErrorFrame(ws, 1500);
  if (ws.readyState !== WebSocket.OPEN) fail("socket closed after sending the frame");
  console.log("    20-byte 0x5A frame accepted, no error, socket still open");

  // A 19-byte frame must be rejected with {t:error}.
  const bad = new Uint8Array(19);
  ws.send(bad);
  const errMsg = await recvJson(ws, 5000, "error on 19-byte frame");
  if (errMsg.t !== "error") fail("expected {t:error} for 19-byte frame, got " + JSON.stringify(errMsg));
  console.log("    19-byte frame rejected with {t:error} OK");

  ws.close();
  console.log("    PASS: WS loopback (BLE hop is verify_bridge.py on hardware)");
} catch (e) {
  fail(e.message);
}
' "ws://127.0.0.1:${BRIDGE_PORT}" || die "WS loopback failed"
ok "WS loopback complete"

cleanup_bridge
trap - EXIT

echo ""
echo "SMOKE RESULT: $PASS checks passed, $FAIL failed"
echo ""
echo "Hardware step (needs a BLE adapter + BlueZ, run on the laptop):"
echo "  cd $SIM_DIR/bridge && python3 jupiter-ble-bridge.py"
echo "  python3 verify_bridge.py   # bleak end-to-end: BLE<->WS byte-identical"
