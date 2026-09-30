#!/usr/bin/env python3
"""Smoke test for the Jupiter BLE bridge's WebSocket layer (no BlueZ needed).

Starts only the WS layer of jupiter-ble-bridge.py and asserts the exact
wire protocol:

  1. join/joined handshake: {"t":"join","role":"sim"} -> {"t":"joined"}
     followed by {"t":"ble","connected":false}.
  2. A 20-byte binary frame from the webapp is accepted (queued for BLE
     notify).
  3. A 19-byte binary frame is rejected with {"t":"error",...} and is not
     queued.
  4. {"t":"ble","connected":true/false} shape from set_ble_link(), and
     publish_ble_write() forwards raw 20-byte frames as binary WS messages.
  5. GET /health (plain HTTP, same port) -> {"ok":true,"ble":bool}.
  6. Auth frames (0x9A first byte) are detected and dropped, never forwarded.
  7. A second join replaces the first client.

Run:  python3 smoke_local.py
Requires: websockets (pip install -r requirements.txt). No BlueZ, no root.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve as ws_serve


def _load_bridge():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jupiter-ble-bridge.py")
    spec = importlib.util.spec_from_file_location("jupiter_ble_bridge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bridge = _load_bridge()


def check(name: str, cond: bool) -> None:
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        raise SystemExit("smoke test failed at: " + name)


async def recv_text_json(ws, timeout=5.0):
    msg = await asyncio.wait_for(ws.recv(), timeout)
    assert isinstance(msg, str), "expected text, got %r" % type(msg)
    return json.loads(msg)


async def main() -> None:
    hub = bridge.WsHub()
    server = await ws_serve(
        hub.ws_handler, "127.0.0.1", 0,
        process_request=hub.process_request, max_size=64,
    )
    port = server.sockets[0].getsockname()[1]
    uri = "ws://127.0.0.1:%d/" % port
    print("WS server on %s" % uri)

    async with connect(uri, max_size=64) as ws:
        # 1. join/joined handshake
        await ws.send(json.dumps({"t": "join", "role": "sim"}))
        msg = await recv_text_json(ws)
        check("join -> joined", msg == {"t": "joined"})
        msg = await recv_text_json(ws)
        check("ble state after join", msg == {"t": "ble", "connected": False})

        # 2. 20-byte binary accepted -> queued for BLE notify
        frame20 = bytes(range(20))
        await ws.send(frame20)
        await asyncio.sleep(0.2)
        check("20-byte binary queued", hub.notify_queue.qsize() == 1)
        check("20-byte binary queued intact", hub.notify_queue.get_nowait() == frame20)

        # 3. 19-byte binary rejected
        await ws.send(bytes(19))
        msg = await recv_text_json(ws)
        check("19-byte rejected with t=error", msg.get("t") == "error")
        check("19-byte not queued", hub.notify_queue.qsize() == 0)

        # 4. ble link state broadcast shape + BLE write forwarding
        hub.set_ble_link(True)
        msg = await recv_text_json(ws)
        check("ble connected=true shape", msg == {"t": "ble", "connected": True})
        phone_frame = bytes([0x55]) + bytes(19)
        await hub.publish_ble_write(phone_frame)
        got = await asyncio.wait_for(ws.recv(), 5.0)
        check("BLE write forwarded as binary", isinstance(got, bytes) and got == phone_frame)
        hub.set_ble_link(False)
        msg = await recv_text_json(ws)
        check("ble connected=false shape", msg == {"t": "ble", "connected": False})

        # 6. auth frame detected and dropped, never forwarded
        auth_frame = bytes([0x9A]) + bytes(19)
        await hub.publish_ble_write(auth_frame)
        check("auth frame counted as dropped", hub.auth_dropped == 1)
        try:
            extra = await asyncio.wait_for(ws.recv(), 0.5)
            check("auth frame never forwarded", False)
        except asyncio.TimeoutError:
            check("auth frame never forwarded", True)

        # 7. second join replaces the first client
        ws2 = await connect(uri, max_size=64)
        try:
            await ws2.send(json.dumps({"t": "join", "role": "sim"}))
            msg = await recv_text_json(ws2)
            check("second join -> joined", msg == {"t": "joined"})
            try:
                await asyncio.wait_for(ws.recv(), 5.0)
                check("old client closed on replace", False)
            except Exception:
                check("old client closed on replace", True)
        finally:
            await ws2.close()

    server.close()
    await server.wait_closed()

    # 5. GET /health over plain HTTP on the same port (fresh server)
    hub2 = bridge.WsHub()
    hub2.ble_link = True
    server2 = await ws_serve(
        hub2.ws_handler, "127.0.0.1", 0,
        process_request=hub2.process_request, max_size=64,
    )
    port2 = server2.sockets[0].getsockname()[1]
    try:
        # http.client is blocking: run it in a thread so the asyncio
        # server can still answer on this same event loop.
        def fetch_health():
            conn = http.client.HTTPConnection("127.0.0.1", port2, timeout=5)
            conn.request("GET", "/health")
            resp = conn.getresponse()
            return resp.status, resp.getheader("Content-Type"), resp.read().decode()

        loop = asyncio.get_running_loop()
        status, ctype, body = await loop.run_in_executor(None, fetch_health)
        check("/health status 200", status == 200)
        check("/health body", json.loads(body) == {"ok": True, "ble": True})
        check("/health content-type", ctype == "application/json")
    finally:
        server2.close()
        await server2.wait_closed()

    print("ALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
