#!/usr/bin/env python3
"""
verify_bridge.py: hardware-level verification for the Scoot Scooter Simulator
Jupiter BLE bridge (sim/bridge/jupiter-ble-bridge.py, built by W4-bridge).

The bridge exposes a BlueZ GATT server with the real Jupiter UUIDs and
relays 20-byte frames between BLE and a WebSocket server. This script is
the verifier: it acts as both a WebSocket client and a bleak BLE central
and checks the bridge end to end. No phone is needed. No app changes.

Install deps first:
    pip install bleak websockets

Steps:
  1. WS handshake: connect to ws://127.0.0.1:8765, send
     {"t":"join","role":"sim"}, expect {"t":"joined"}.
  2. BLE discovery: scan for service UUID
     5456534D-5647-5341-5342-454E544F5251 ("Jupiter-SIM"), connect,
     discover services, assert write char
     00005352-0000-1000-8000-00805f9b34fb and notify char
     00005354-0000-1000-8000-00805f9b34fb exist.
  3a. BLE -> WS: write a 20-byte 0x5B frame to the write char via bleak,
      assert the SAME bytes arrive at the WS client as binary.
  3b. WS -> BLE: send a 20-byte 0x5A binary frame via WS, assert it
      arrives via the bleak notify callback byte-identical.
  4.  Malformed: send a 19-byte binary frame via WS, assert it is
      rejected (no notify fires, no binary is forwarded to WS clients).

Usage:
  python3 verify_bridge.py                 # full run against the real bridge
  python3 verify_bridge.py --skip-ble       # WS steps only (no BT adapter needed)
  python3 verify_bridge.py --self-test     # client-logic self check against an
                                           # in-process mock WS server (no bridge,
                                           # no BLE; validates this script's own
                                           # WS framing, parsing and timeouts)

Expected values come from sim/docs/PROTOCOL.md (frame anatomy, UUIDs),
not from the bridge implementation. Exit code is 0 only if every step
passes.
"""

import argparse
import asyncio
import binascii
import json
import sys

WS_URL = "ws://127.0.0.1:8765"
ADV_NAME = "Jupiter-SIM"
SERVICE_UUID = "5456534d-5647-5341-5342-454e544f5251"
WRITE_UUID = "00005352-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "00005354-0000-1000-8000-00805f9b34fb"

SCAN_TIMEOUT = 10.0
FRAME_TIMEOUT = 5.0
REJECT_WINDOW = 3.0

try:
    import websockets
except ImportError:
    print("FAIL: the 'websockets' package is missing. Run: pip install bleak websockets",
          file=sys.stderr)
    sys.exit(2)


def hx(b):
    """Compact hex dump of bytes."""
    return binascii.hexlify(bytes(b)).decode()


def jupiter_checksum(first18):
    """PROTOCOL.md section 2: checksum = 255 - (sum(bytes[0..17]) % 256)."""
    assert len(first18) == 18
    return 255 - (sum(first18) % 256)


def build_frame(start, frame_id, payload16):
    """Build a valid 20-byte Jupiter frame: start, id, 16 payload bytes,
    checksum at byte 18, 0xFF at byte 19."""
    assert len(payload16) == 16
    body = bytes([start, frame_id]) + bytes(payload16)
    return body + bytes([jupiter_checksum(body), 0xFF])


def byte_diff(expected, actual):
    """Describe a byte-level difference, or None if identical."""
    if expected == actual:
        return None
    lines = [
        "expected (%d bytes): %s" % (len(expected), hx(expected)),
        "actual   (%d bytes): %s" % (len(actual), hx(actual)),
    ]
    n = min(len(expected), len(actual))
    for i in range(n):
        if expected[i] != actual[i]:
            lines.append("first difference at index %d: expected 0x%02X, got 0x%02X"
                         % (i, expected[i], actual[i]))
            break
    if len(expected) != len(actual):
        lines.append("length differs: expected %d, got %d"
                     % (len(expected), len(actual)))
    return "\n    ".join(lines)


def report(step, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print("[%s] step %s" % (status, step))
    if detail:
        for line in str(detail).splitlines():
            print("    " + line)
    return ok


# ---------------------------------------------------------------- WS helpers

async def ws_join(url):
    """Connect, send the join message, wait for {"t":"joined"}.

    Returns (websocket, ok, detail). Extra fields on the joined message
    (room, peer) are tolerated; only t == "joined" is required.
    """
    try:
        ws = await websockets.connect(url)
    except Exception as e:
        return None, False, "connect to %s failed: %r" % (url, e)
    try:
        await ws.send(json.dumps({"t": "join", "role": "sim"}))
        deadline = asyncio.get_event_loop().time() + FRAME_TIMEOUT
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                await ws.close()
                return None, False, "timed out waiting for joined message"
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            if isinstance(raw, bytes):
                continue  # binary before join ack is not the ack; keep waiting
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if isinstance(msg, dict) and msg.get("t") == "joined":
                return ws, True, "got %s" % raw
    except Exception as e:
        try:
            await ws.close()
        except Exception:
            pass
        return None, False, "handshake failed: %r" % e


async def ws_recv_binary(ws, timeout):
    """Wait for a binary WS message; returns (bytes, info) or (None, info).
    Text messages seen while waiting are returned as info only."""
    notes = []
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            info = "no binary received within %.1fs" % timeout
            if notes:
                info += "; text seen: %s" % "; ".join(notes)
            return None, info
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            info = "no binary received within %.1fs" % timeout
            if notes:
                info += "; text seen: %s" % "; ".join(notes)
            return None, info
        if isinstance(raw, bytes):
            return bytes(raw), "binary received (%d bytes)" % len(raw)
        notes.append(str(raw)[:120])


async def step1_ws_handshake(url):
    ws, ok, detail = await ws_join(url)
    if not ok:
        report("1 (WS handshake)", False, detail)
        return None
    report("1 (WS handshake)", True, detail)
    return ws


# ---------------------------------------------------------------- BLE steps

async def step2_ble_discovery():
    try:
        from bleak import BleakClient, BleakScanner
    except ImportError:
        return report("2 (BLE discovery)", False,
                      "the 'bleak' package is missing. Run: pip install bleak websockets"), None

    print("    scanning for service UUID %s (%.0fs)..." % (SERVICE_UUID, SCAN_TIMEOUT))
    try:
        devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT)
    except Exception as e:
        return report("2 (BLE discovery)", False,
                      "scan failed: %r (is bluetoothd running? does this host have a BT adapter?)" % e), None

    target = None
    for d in devices:
        adv_uuids = [u.lower() for u in (d.metadata.get("uuids") or [])]
        if SERVICE_UUID in adv_uuids:
            target = d
            print("    candidate: %s (%s) advertises the service UUID" % (d.name, d.address))
            break
    if target is None:
        for d in devices:
            if (d.name or "") == ADV_NAME:
                target = d
                print("    WARNING: no advertisement carried the service UUID; "
                      "falling back to name match %r (%s)" % (d.name, d.address))
                break
    if target is None:
        seen = ", ".join("%s (%s)" % (d.name, d.address) for d in devices) or "<none>"
        return report("2 (BLE discovery)", False,
                      "no device found. Saw %d device(s): %s" % (len(devices), seen)), None

    client = BleakClient(target)
    try:
        await client.connect()
    except Exception as e:
        return report("2 (BLE discovery)", False,
                      "connect to %s (%s) failed: %r" % (target.name, target.address, e)), None

    try:
        services = client.services
        chars = {}
        for svc in services:
            for ch in svc.characteristics:
                chars[ch.uuid.lower()] = ch
        detail_lines = ["connected to %s (%s)" % (target.name, target.address),
                        "services: %s" % ", ".join(s.uuid.lower() for s in services),
                        "characteristics:"]
        for uuid, ch in sorted(chars.items()):
            detail_lines.append("  %s  props=%s" % (uuid, ",".join(sorted(ch.properties))))
        ok = True
        if WRITE_UUID not in chars:
            ok = False
            detail_lines.append("MISSING write char %s" % WRITE_UUID)
        if NOTIFY_UUID not in chars:
            ok = False
            detail_lines.append("MISSING notify char %s" % NOTIFY_UUID)
        report("2 (BLE discovery)", ok, "\n".join(detail_lines))
        if not ok:
            await client.disconnect()
            return False, None
        return True, (client, chars[WRITE_UUID], chars[NOTIFY_UUID])
    except Exception as e:
        try:
            await client.disconnect()
        except Exception:
            pass
        return report("2 (BLE discovery)", False, "service discovery failed: %r" % e), None


async def step3a_ble_to_ws(client, write_char, ws):
    """Write a 0x5B frame over BLE; the same bytes must arrive at the WS
    client as binary within FRAME_TIMEOUT."""
    payload = bytes(range(16))
    frame = build_frame(0x5B, 0x4A, payload)
    assert len(frame) == 20 and frame[0] == 0x5B and frame[19] == 0xFF

    recv_task = asyncio.ensure_future(ws_recv_binary(ws, FRAME_TIMEOUT))
    await asyncio.sleep(0.1)  # let the recv waiter arm first
    try:
        await client.write_gatt_char(write_char, frame)
    except Exception as e:
        recv_task.cancel()
        return report("3a (BLE->WS)", False, "bleak write_gatt_char failed: %r" % e)

    got, info = await recv_task
    if got is None:
        return report("3a (BLE->WS)", False,
                      "wrote %s but %s" % (hx(frame), info))
    diff = byte_diff(frame, got)
    if diff is not None:
        return report("3a (BLE->WS)", False,
                      "bytes differ.\n    %s" % diff)
    return report("3a (BLE->WS)", True,
                  "wrote 20-byte 0x5B frame via BLE, WS client got identical bytes: %s" % hx(got))


async def step3b_ws_to_ble(client, notify_char, ws):
    """Send a 0x5A binary frame via WS; it must arrive through the bleak
    notify callback byte-identical within FRAME_TIMEOUT."""
    payload = bytes([0xA0 + i for i in range(16)])
    frame = build_frame(0x5A, 0x10, payload)
    assert len(frame) == 20 and frame[0] == 0x5A and frame[19] == 0xFF

    received = []
    arrived = asyncio.Event()

    def on_notify(sender, data):
        received.append(bytes(data))
        arrived.set()

    try:
        await client.start_notify(notify_char, on_notify)
    except Exception as e:
        return report("3b (WS->BLE)", False, "start_notify failed: %r" % e)

    try:
        await ws.send(frame)  # bytes -> binary WS frame
    except Exception as e:
        await client.stop_notify(notify_char)
        return report("3b (WS->BLE)", False, "WS binary send failed: %r" % e)

    try:
        await asyncio.wait_for(arrived.wait(), timeout=FRAME_TIMEOUT)
    except asyncio.TimeoutError:
        await client.stop_notify(notify_char)
        return report("3b (WS->BLE)", False,
                      "sent %s via WS but no notify arrived within %.1fs" % (hx(frame), FRAME_TIMEOUT))

    got = received[0]
    diff = byte_diff(frame, got)
    if diff is not None:
        await client.stop_notify(notify_char)
        return report("3b (WS->BLE)", False,
                      "notify bytes differ.\n    %s" % diff)
    extra = "" if len(received) == 1 else " (WARNING: %d notifies arrived, used first)" % len(received)
    await client.stop_notify(notify_char)
    return report("3b (WS->BLE)", True,
                  "WS binary frame arrived via notify byte-identical: %s%s" % (hx(got), extra))


async def step4_malformed_rejection(client, notify_char, ws):
    """Send a 19-byte binary frame via WS. The bridge must reject it:
    no notify may fire and no binary may be forwarded to WS clients."""
    bad = bytes([0x5A, 0x10]) + bytes(range(17))  # 19 bytes, structurally short
    assert len(bad) == 19

    notifies = []
    arrived = asyncio.Event()

    def on_notify(sender, data):
        notifies.append(bytes(data))
        arrived.set()

    watching_ble = False
    if client is not None and notify_char is not None:
        try:
            await client.start_notify(notify_char, on_notify)
            watching_ble = True
        except Exception as e:
            return report("4 (malformed)", False, "start_notify failed: %r" % e)

    try:
        await ws.send(bad)
    except Exception as e:
        if watching_ble:
            await client.stop_notify(notify_char)
        return report("4 (malformed)", False, "WS binary send failed: %r" % e)

    # Drain the WS client for the whole window; any binary arrival is a failure.
    ws_binary = []
    ws_text = []
    deadline = asyncio.get_event_loop().time() + REJECT_WINDOW
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            break
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        if isinstance(raw, bytes):
            ws_binary.append(bytes(raw))
        else:
            ws_text.append(str(raw)[:120])

    if watching_ble:
        await client.stop_notify(notify_char)

    notes = []
    if ws_text:
        notes.append("WS text seen (info only): %s" % "; ".join(ws_text))
    if notifies:
        notes.append("REJECTED frame still fired notify: %s" % hx(notifies[0]))
    if ws_binary:
        notes.append("REJECTED frame still forwarded to WS: %s" % hx(ws_binary[0]))

    ok = not notifies and not ws_binary
    detail = ("sent 19-byte binary %s; " % hx(bad)
              + ("bridge dropped it: no notify, no WS forward" if ok
                 else "BRIDGE FORWARDED A MALFORMED FRAME")
              + ("; " + "; ".join(notes) if notes else ""))
    return report("4 (malformed)", ok, detail)


# ---------------------------------------------------------------- runners

async def run_full(url, skip_ble):
    results = []
    ws = await step1_ws_handshake(url)
    results.append(ws is not None)
    if ws is None:
        print("\nRESULT: FAIL (bridge WS server not reachable or handshake broken)")
        return 1

    client = notify_char = write_char = None
    try:
        if not skip_ble:
            ok, ble = await step2_ble_discovery()
            results.append(ok)
            if not ok or ble is None:
                print("\nRESULT: FAIL")
                return 1
            client, write_char, notify_char = ble

            results.append(await step3a_ble_to_ws(client, write_char, ws))
            results.append(await step3b_ws_to_ble(client, notify_char, ws))
            results.append(await step4_malformed_rejection(client, notify_char, ws))
        else:
            # WS-only mode: check malformed frames are not echoed to WS clients.
            results.append(await step4_malformed_rejection(None, None, ws))
            print("    (BLE steps skipped: --skip-ble)")
    finally:
        try:
            if client is not None:
                await client.disconnect()
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass

    if all(results):
        print("\nRESULT: PASS (%d/%d steps)" % (len(results), len(results)))
        return 0
    print("\nRESULT: FAIL")
    return 1


# ---------------------------------------------------------------- self-test
# Validates this script's own WS client logic (framing, parsing, timeouts)
# against an in-process mock that behaves like the bridge WS protocol:
# join/joined handshake, 20-byte binary frames echoed to WS clients,
# non-20-byte binary frames dropped. No bridge, no BLE involved.

MOCK_URL = "ws://127.0.0.1:8766"


async def _mock_bridge_handler(ws, path=None):
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=5)
    except Exception:
        return
    try:
        msg = json.loads(raw) if isinstance(raw, str) else {}
    except Exception:
        msg = {}
    if not isinstance(msg, dict) or msg.get("t") != "join":
        await ws.send(json.dumps({"t": "error", "msg": "expected join"}))
        return
    await ws.send(json.dumps({"t": "joined", "role": msg.get("role")}))
    async for m in ws:
        if isinstance(m, bytes):
            if len(m) == 20:
                await ws.send(bytes(m))  # loopback: simulates bridge forwarding
            # else: drop silently = rejection
        else:
            await ws.send(json.dumps({"t": "error", "msg": "binary only"}))


async def run_self_test():
    results = []
    server = await websockets.serve(_mock_bridge_handler, "127.0.0.1", 8766)
    try:
        ws = await step1_ws_handshake(MOCK_URL)
        results.append(ws is not None)
        if ws is None:
            print("\nSELF-TEST RESULT: FAIL")
            return 1
        try:
            # 20-byte frames loop back byte-identical through the mock.
            for start, fid in ((0x5A, 0x10), (0x5B, 0x4A)):
                frame = build_frame(start, fid, bytes(range(16)))
                await ws.send(frame)
                got, info = await ws_recv_binary(ws, FRAME_TIMEOUT)
                diff = byte_diff(frame, got) if got is not None else "no echo: " + info
                results.append(report("self-test echo 0x%02X" % start, diff is None,
                                      "round trip %s" % (hx(got) if got else info)
                                      if diff is None else diff))
            # 19-byte frame must be dropped: nothing binary comes back.
            bad = bytes([0x5A, 0x10]) + bytes(range(17))
            await ws.send(bad)
            got, info = await ws_recv_binary(ws, REJECT_WINDOW)
            results.append(report("self-test malformed drop", got is None,
                                  "19-byte frame dropped, %s" % info if got is None
                                  else "MOCK echoed malformed frame: %s" % hx(got)))
        finally:
            await ws.close()
    finally:
        server.close()
        await server.wait_closed()

    if all(results):
        print("\nSELF-TEST RESULT: PASS (%d/%d)" % (len(results), len(results)))
        return 0
    print("\nSELF-TEST RESULT: FAIL")
    return 1


def main():
    ap = argparse.ArgumentParser(description="Verify the Jupiter BLE bridge (WS + BLE).")
    ap.add_argument("--url", default=WS_URL, help="bridge WS URL (default %(default)s)")
    ap.add_argument("--skip-ble", action="store_true",
                    help="run WS steps only (step 1 + malformed WS check)")
    ap.add_argument("--self-test", action="store_true",
                    help="validate this script's WS client logic against an in-process mock")
    args = ap.parse_args()

    if args.self_test:
        return asyncio.run(run_self_test())
    return asyncio.run(run_full(args.url, args.skip_ble))


if __name__ == "__main__":
    sys.exit(main())
