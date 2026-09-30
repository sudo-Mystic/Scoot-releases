#!/usr/bin/env python3
"""
Jupiter BLE bridge for Windows: makes the Windows PC look exactly like the
real TVS Jupiter scooter's BLE cluster, and pipes 20-byte Jupiter frames
to/from the Scoot Scooter Simulator webapp over WebSocket.

Architecture (no app changes): the phone app speaks BLE GATT to this
bridge; the bridge forwards app writes to the sim webapp and notifies
sim telemetry frames back to the phone.

    phone app  <--BLE GATT-->  this bridge  <--WebSocket-->  sim webapp

This is the Windows twin of jupiter-ble-bridge.py (Linux/BlueZ). The
WebSocket wire protocol is IDENTICAL (same WsHub logic, embedded below),
so the sim webapp cannot tell which bridge it is talking to. Only the
BLE layer differs: Windows has no D-Bus/BlueZ, so the GATT server is
built on the WinRT GattServiceProvider API (package: winrt-runtime) plus a
BluetoothLEAdvertisementPublisher for the "Jupiter-SIM" advertisement
carrying the real Jupiter service UUID. This file is fully standalone:
it needs no other files from the repo and can be renamed freely.

SAFETY BOUNDARY (non-negotiable, same as the Linux bridge):
  The bridge emulates the cluster only: telemetry out over BLE notify,
  app writes forwarded in. It NEVER implements lock/unlock/immobilizer/
  throttle/brake control and NEVER implements the 0x9A/0xF2/0xF1 auth
  challenge-response. An auth frame arriving on the write characteristic
  is logged as detected (like the app does) and dropped, never answered.
  That logic lives in the shared WsHub.publish_ble_write().

Wire protocol (exact, the webapp transport and verifier depend on it):
  webapp -> bridge text: {"t":"join","role":"sim"} (single client; a new
      join replaces the old one).
  bridge -> webapp text: {"t":"joined"} on accept;
      {"t":"ble","connected":true} when the phone central connects AND
      subscribes to notify; {"t":"ble","connected":false} on
      disconnect/unsubscribe.
  binary messages, both directions: raw 20-byte Jupiter frames.
      bridge->webapp: frames written by the phone app.
      webapp->bridge: frames to notify to the phone (must be exactly
      20 bytes; anything else is rejected with {"t":"error",...}).
      Notify direction is throttled to <=50 Hz via an asyncio queue
      (drop-oldest on overflow, drops counted).
  GET /health (same port, plain HTTP) -> {"ok":true,"ble":true|false}.

Prerequisites (Windows 10+, Bluetooth radio with BLE peripheral support):
  pip install -r requirements-windows.txt   (websockets + winrt-runtime
                                             + the winrt-Windows.* namespace packages)

Run:  python .\\jupiter-ble-bridge-windows.py [--host 0.0.0.0] [--port 8765] [--no-ble]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
import traceback
from uuid import UUID

from websockets import Headers, Request, Response
from websockets.asyncio.server import ServerConnection, serve as ws_serve

log = logging.getLogger("jupiter-ble-bridge")

# --------------------------------------------------------------------------
# WebSocket hub: byte-identical wire protocol to the Linux bridge
# (jupiter-ble-bridge.py). Embedded here so this file is fully
# standalone: no sibling files, no import tricks, rename-proof.
# --------------------------------------------------------------------------

SERVICE_UUID = "5456534D-5647-5341-5342-454E544F5251"
WRITE_CHAR_UUID = "00005352-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR_UUID = "00005354-0000-1000-8000-00805f9b34fb"
LOCAL_NAME = "Jupiter-SIM"

FRAME_LEN = 20
NOTIFY_MIN_INTERVAL_S = 0.02  # <=50 Hz notify rate
NOTIFY_QUEUE_MAX = 512
STATS_INTERVAL_S = 30.0

# First byte values that mark auth challenge/response frames. These are
# detected, logged, and DROPPED: the bridge never answers them.
AUTH_FIRST_BYTES = frozenset({0x9A, 0xF2, 0xF1})




# --------------------------------------------------------------------------
# WebSocket layer (no BlueZ dependency; importable for smoke tests)
# --------------------------------------------------------------------------

class WsHub:
    """Pairs the BLE side with the single connected sim webapp client.

    BLE writes arrive via publish_ble_write() and go out as binary WS
    messages. Webapp binary frames arrive in ws_handler() and are queued
    for BLE notify; the BLE side drains the queue with enqueue/notify.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._client: ServerConnection | None = None
        self.ble_link: bool = False

        # webapp -> phone direction: throttled to <=50 Hz, drop-oldest.
        self.notify_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=NOTIFY_QUEUE_MAX)
        self._last_notify = 0.0

        # Counters for periodic stats logging.
        self.rx_frames = 0            # BLE write frames received
        self.rx_forwarded = 0         # forwarded to webapp
        self.rx_dropped_no_client = 0
        self.rx_dropped_bad_len = 0
        self.tx_frames = 0            # notified to phone
        self.tx_dropped_overflow = 0  # queue overflow drops
        self.auth_dropped = 0         # auth frames detected and dropped

    # -- webapp client management ----------------------------------------

    async def _current_client(self) -> ServerConnection | None:
        async with self._lock:
            return self._client

    async def _send_text(self, client: ServerConnection, obj: dict) -> bool:
        try:
            await client.send(json.dumps(obj))
            return True
        except Exception as exc:  # client went away mid-send
            log.debug("WS send failed: %s", exc)
            return False

    async def ws_handler(self, connection: ServerConnection) -> None:
        peer = getattr(connection, "remote_address", "?")
        log.info("WS connection from %s", peer)
        try:
            async for message in connection:
                if isinstance(message, str):
                    await self._handle_text(connection, message)
                else:
                    await self._handle_binary(connection, message)
        except Exception as exc:
            log.debug("WS handler error for %s: %s", peer, exc)
        finally:
            async with self._lock:
                if self._client is connection:
                    self._client = None
                    log.info("sim webapp client disconnected")

    async def _handle_text(self, connection: ServerConnection, message: str) -> None:
        try:
            msg = json.loads(message)
        except ValueError:
            log.debug("ignoring non-JSON WS text")
            return
        if not isinstance(msg, dict) or msg.get("t") != "join" or msg.get("role") != "sim":
            log.debug("ignoring WS text message: %.60r", message)
            return
        async with self._lock:
            old = self._client
            self._client = connection
        if old is not None and old is not connection:
            log.info("new sim client joined: replacing previous client")
            try:
                await old.close(code=4001, reason="replaced by new sim client")
            except Exception:
                pass
        await self._send_text(connection, {"t": "joined"})
        await self._send_text(connection, {"t": "ble", "connected": self.ble_link})
        log.info("sim webapp client joined from %s", getattr(connection, "remote_address", "?"))

    async def _handle_binary(self, connection: ServerConnection, message: bytes | bytearray) -> None:
        client = await self._current_client()
        if client is not connection:
            log.debug("binary WS message from unjoined client ignored")
            return
        frame = bytes(message)
        if len(frame) != FRAME_LEN:
            log.warning("rejected webapp binary of %d bytes (need %d)", len(frame), FRAME_LEN)
            await self._send_text(
                connection,
                {"t": "error", "msg": "frame must be %d bytes, got %d" % (FRAME_LEN, len(frame))},
            )
            return
        await self.enqueue_notify(frame)

    async def enqueue_notify(self, frame: bytes) -> bool:
        """Queue a 20-byte sim frame for BLE notify. Drop-oldest on
        overflow; every dropped frame is counted. Returns False when the
        frame is not exactly 20 bytes."""
        if len(frame) != FRAME_LEN:
            return False
        while self.notify_queue.full():
            try:
                self.notify_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self.tx_dropped_overflow += 1
        await self.notify_queue.put(frame)
        return True

    # -- /health on the same port ----------------------------------------

    async def process_request(self, connection: ServerConnection, request: Request):  # noqa: ANN201
        if request.path == "/health" and request.method.upper() == "GET":
            body = json.dumps({"ok": True, "ble": self.ble_link}).encode("ascii")
            return Response(
                200,
                "OK",
                Headers(
                    {
                        "Content-Type": "application/json",
                        "Content-Length": str(len(body)),
                        "Connection": "close",
                    }
                ),
                body,
            )
        if request.path == "/" :
            return None  # let the WebSocket handshake proceed
        body = b"not found"
        return Response(
            404,
            "Not Found",
            Headers({"Content-Type": "text/plain", "Content-Length": str(len(body)), "Connection": "close"}),
            body,
        )

    # -- BLE -> webapp ----------------------------------------------------

    async def publish_ble_write(self, frame: bytes) -> None:
        """Called by the BLE layer for each 20-byte write from the phone."""
        self.rx_frames += 1
        if frame and frame[0] in AUTH_FIRST_BYTES:
            # SAFETY: auth challenge/response frames are detected and
            # dropped here. They are never answered and never forwarded.
            self.auth_dropped += 1
            log.warning(
                "auth frame 0x%02X detected from phone: dropped, never answered (safety boundary)",
                frame[0],
            )
            return
        client = await self._current_client()
        if client is None:
            self.rx_dropped_no_client += 1
            return
        try:
            await client.send(frame)
            self.rx_forwarded += 1
        except Exception as exc:
            self.rx_dropped_no_client += 1
            log.debug("dropped BLE write, webapp client gone: %s", exc)

    # -- webapp -> BLE ----------------------------------------------------

    async def notify_consumer(self, notify_fn) -> None:
        """Drain the notify queue, throttled to <=50 Hz.

        notify_fn: async callable taking 20 bytes; implemented by BLE layer.
        """
        while True:
            frame = await self.notify_queue.get()
            wait = NOTIFY_MIN_INTERVAL_S - (time.monotonic() - self._last_notify)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                await notify_fn(frame)
                self.tx_frames += 1
            except Exception as exc:
                log.warning("BLE notify failed: %s", exc)
            self._last_notify = time.monotonic()

    def set_ble_link(self, connected: bool) -> None:
        if connected == self.ble_link:
            return
        self.ble_link = connected
        log.info("BLE phone link %s (connected AND subscribed)", "UP" if connected else "DOWN")
        loop = asyncio.get_running_loop()
        loop.create_task(self._broadcast_ble())

    async def _broadcast_ble(self) -> None:
        client = await self._current_client()
        if client is None:
            return
        await self._send_text(client, {"t": "ble", "connected": self.ble_link})

    def stats_snapshot(self) -> dict:
        return {
            "rx_frames": self.rx_frames,
            "rx_forwarded": self.rx_forwarded,
            "rx_dropped_no_client": self.rx_dropped_no_client,
            "rx_dropped_bad_len": self.rx_dropped_bad_len,
            "tx_frames": self.tx_frames,
            "tx_dropped_overflow": self.tx_dropped_overflow,
            "auth_dropped": self.auth_dropped,
            "queue_depth": self.notify_queue.qsize(),
            "ble_link": self.ble_link,
        }


async def stats_loop(hub: WsHub) -> None:
    while True:
        await asyncio.sleep(STATS_INTERVAL_S)
        s = hub.stats_snapshot()
        log.info(
            "stats rx=%d fwd=%d (no_client=%d bad_len=%d) tx=%d (overflow_drop=%d) "
            "auth_dropped=%d queue=%d ble_link=%s",
            s["rx_frames"], s["rx_forwarded"], s["rx_dropped_no_client"],
            s["rx_dropped_bad_len"], s["tx_frames"], s["tx_dropped_overflow"],
            s["auth_dropped"], s["queue_depth"], s["ble_link"],
        )


# BLE layer (WinRT GattServiceProvider). winrt is imported lazily so the
# WS layer above stays importable/testable without it.
# --------------------------------------------------------------------------

def _require_winrt():
    try:
        from winrt.windows.devices.bluetooth import BluetoothAdapter, BluetoothError
        from winrt.windows.devices.bluetooth.advertisement import (
            BluetoothLEAdvertisementPublisher,
            BluetoothLEAdvertisementPublisherStatus,
        )
        from winrt.windows.devices.bluetooth.genericattributeprofile import (
            GattCharacteristicProperties,
            GattLocalCharacteristicParameters,
            GattProtectionLevel,
            GattServiceProvider,
        )
        from winrt.windows.storage.streams import DataReader, DataWriter
        return {
            "BluetoothAdapter": BluetoothAdapter,
            "BluetoothError": BluetoothError,
            "BluetoothLEAdvertisementPublisher": BluetoothLEAdvertisementPublisher,
            "BluetoothLEAdvertisementPublisherStatus": BluetoothLEAdvertisementPublisherStatus,
            "GattCharacteristicProperties": GattCharacteristicProperties,
            "GattLocalCharacteristicParameters": GattLocalCharacteristicParameters,
            "GattProtectionLevel": GattProtectionLevel,
            "GattServiceProvider": GattServiceProvider,
            "DataReader": DataReader,
            "DataWriter": DataWriter,
        }
    except ImportError:
        log.error(
            "FATAL: the 'winrt' module is not installed. "
            "Run: pip install -r requirements-windows.txt "
            "(or: pip install winrt-runtime websockets "
            "winrt-Windows.Devices.Bluetooth[all] "
            "winrt-Windows.Devices.Bluetooth.Advertisement[all] "
            "winrt-Windows.Devices.Bluetooth.GenericAttributeProfile[all] "
            "winrt-Windows.Storage.Streams[all])."
        )
        sys.exit(2)


# BluetoothError codes, so a failed create_async logs a name and a hint
# instead of a bare number.
_BT_ERROR_NAMES = {
    0: "Success",
    1: "RadioNotAvailable",
    2: "ResourceInUse",
    3: "DeviceNotConnected",
    4: "OtherError",
    5: "DisabledByPolicy",
    6: "NotSupported",
    7: "DisabledByUser",
    8: "ConsentRequired",
    9: "TransportNotSupported",
}
_BT_ERROR_HINTS = {
    1: "The Bluetooth radio is not available to Windows. Turn Bluetooth ON "
       "in Windows Settings and make sure Airplane mode is off.",
    5: "Blocked by system policy on this PC.",
    6: "Not supported by this Bluetooth radio/driver.",
    7: "Bluetooth was disabled by the user. Turn it back on in Windows Settings.",
}


def _bt_error_name(err) -> str:
    try:
        code = int(err)
    except (TypeError, ValueError):
        return str(err)
    return "%s (%d)" % (_BT_ERROR_NAMES.get(code, "Unknown"), code)


def _ibuffer_from_bytes(winrt, data: bytes):
    writer = winrt["DataWriter"]()
    writer.write_bytes(data)
    return writer.detach_buffer()


def _bytes_from_ibuffer(winrt, buf) -> bytes:
    reader = winrt["DataReader"].from_buffer(buf)
    raw = bytearray(reader.unconsumed_buffer_length)
    reader.read_bytes(raw)
    return bytes(raw)


class _WinBleServer:
    """WinRT GATT server: Jupiter service + write/notify characteristics,
    plus a BLE advertisement as LOCAL_NAME carrying SERVICE_UUID.

    One instance per BLE session; created inside ble_task() after the lazy
    winrt import.
    """

    def __init__(self, winrt, hub: WsHub, loop: asyncio.AbstractEventLoop):
        self._winrt = winrt
        self._hub = hub
        self._loop = loop
        self._provider = None
        self._write_char = None
        self._notify_char = None
        self._publisher = None
        self._tokens = []
        self._subscribed = False

    # -- setup -----------------------------------------------------------

    async def start(self) -> None:
        w = self._winrt
        # Fail fast with a useful message instead of a bare error code.
        adapter = await w["BluetoothAdapter"].get_default_async()
        if adapter is None:
            raise RuntimeError(
                "no default Bluetooth adapter found. Turn Bluetooth ON in "
                "Windows Settings (and switch Airplane mode off)."
            )
        peripheral_ok = getattr(adapter, "is_peripheral_role_supported", None)
        if peripheral_ok is False:
            raise RuntimeError(
                "this PC's Bluetooth radio does not support BLE peripheral "
                "mode, so the phone can never see the Jupiter-SIM advertisement "
                "from this PC. Options: a USB BLE dongle with peripheral-mode "
                "support, or run the Linux bridge on a machine whose radio "
                "supports it."
            )
        result = await w["GattServiceProvider"].create_async(UUID(SERVICE_UUID))
        if result.error != w["BluetoothError"].SUCCESS:
            hint = _BT_ERROR_HINTS.get(int(result.error), "")
            raise RuntimeError(
                "GattServiceProvider.create_async failed: %s. %s"
                % (_bt_error_name(result.error), hint)
            )
        self._provider = result.service_provider
        log.info("GATT service provider created (service %s)", SERVICE_UUID)

        # Phone -> cluster: write characteristic (same UUID/flags as BlueZ).
        wp = w["GattLocalCharacteristicParameters"]()
        wp.characteristic_properties = (
            w["GattCharacteristicProperties"].WRITE
            | w["GattCharacteristicProperties"].WRITE_WITHOUT_RESPONSE
        )
        wp.write_protection_level = w["GattProtectionLevel"].PLAIN
        wp.read_protection_level = w["GattProtectionLevel"].PLAIN
        wp.user_description = "Jupiter app-to-cluster"
        wres = await self._provider.service.create_characteristic_async(UUID(WRITE_CHAR_UUID), wp)
        if wres.error != w["BluetoothError"].SUCCESS:
            raise RuntimeError("create write characteristic failed: %s" % wres.error)
        self._write_char = wres.characteristic
        self._tokens.append(self._write_char.add_write_requested(self._on_write_requested))
        log.info("write characteristic ready (%s)", WRITE_CHAR_UUID)

        # Cluster -> phone: notify characteristic (same UUID as BlueZ).
        np = w["GattLocalCharacteristicParameters"]()
        np.characteristic_properties = w["GattCharacteristicProperties"].NOTIFY
        np.write_protection_level = w["GattProtectionLevel"].PLAIN
        np.read_protection_level = w["GattProtectionLevel"].PLAIN
        np.user_description = "Jupiter cluster-to-app"
        nres = await self._provider.service.create_characteristic_async(UUID(NOTIFY_CHAR_UUID), np)
        if nres.error != w["BluetoothError"].SUCCESS:
            raise RuntimeError("create notify characteristic failed: %s" % nres.error)
        self._notify_char = nres.characteristic
        self._tokens.append(
            self._notify_char.add_subscribed_clients_changed(self._on_subscribed_changed)
        )
        log.info("notify characteristic ready (%s)", NOTIFY_CHAR_UUID)

        # Advertisement: local name + service UUID, like the BlueZ one.
        # "Jupiter-SIM" (11 chars) + a 128-bit service UUID sits at exactly
        # 31 bytes, the legacy advertising limit; some Windows stacks reject
        # Start() with E_INVALIDARG instead of truncating. Fall back through
        # smaller payloads: the phone scans by service UUID, so the name is
        # cosmetic.
        attempts = (("local name + service UUID", True), ("service UUID only", False))
        for desc, with_name in attempts:
            self._publisher = w["BluetoothLEAdvertisementPublisher"]()
            adv = self._publisher.advertisement
            if with_name:
                adv.local_name = LOCAL_NAME
            adv.service_uuids.append(UUID(SERVICE_UUID))
            try:
                log.info("BLE: starting publisher (%s) ...", desc)
                self._publisher.start()
                break
            except OSError as exc:
                last = with_name is False
                if getattr(exc, "winerror", None) != -2147024809 or last:
                    raise
                log.warning(
                    "BLE: advertisement (%s) rejected by the radio "
                    "(E_INVALIDARG); retrying with a smaller payload", desc,
                )
        else:
            raise RuntimeError("advertisement failed")
        if with_name:
            log.info("advertising as %r with service UUID %s", LOCAL_NAME, SERVICE_UUID)
        else:
            log.info(
                "advertising service UUID %s (no local name: radio rejected "
                "the full 31-byte payload)", SERVICE_UUID,
            )
        if self._publisher.status != w["BluetoothLEAdvertisementPublisherStatus"].STARTED:
            raise RuntimeError(
                "BLE advertisement did not start (status=%s). Does this PC's "
                "Bluetooth radio support BLE peripheral mode?" % self._publisher.status
            )

    async def stop(self) -> None:
        if self._publisher is not None:
            try:
                self._publisher.stop()
            except Exception:
                pass
            self._publisher = None
        self._provider = None
        self._write_char = None
        self._notify_char = None
        self._tokens = []
        self._hub.set_ble_link(False)

    # -- WinRT event handlers (fire on background threads; marshal to the
    # -- asyncio loop) ----------------------------------------------------

    def _on_write_requested(self, sender, args) -> None:
        async def _handle():
            w = self._winrt
            try:
                request = await args.get_request_async()
            except Exception as exc:
                log.debug("write request fetch failed: %s", exc)
                return
            if request is None:
                return
            try:
                frame = _bytes_from_ibuffer(w, request.value)
            except Exception as exc:
                log.warning("could not read BLE write value: %s", exc)
                frame = b""
            if len(frame) != FRAME_LEN:
                # Mirrors the BlueZ side: counted and ignored, never stalls.
                self._hub.rx_dropped_bad_len += 1
                log.warning("BLE write of %d bytes ignored (need %d)", len(frame), FRAME_LEN)
            else:
                # Auth frames (0x9A/0xF2/0xF1) are detected and DROPPED
                # inside publish_ble_write: never answered, never forwarded.
                await self._hub.publish_ble_write(frame)
            try:
                request.respond()
            except Exception as exc:
                log.debug("BLE write respond failed: %s", exc)

        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_handle()))

    def _on_subscribed_changed(self, sender, _args) -> None:
        def _update():
            try:
                n = len(sender.subscribed_clients)
            except Exception:
                n = 0
            up = n > 0
            if up != self._subscribed:
                self._subscribed = up
                log.info("phone %s to notify characteristic", "subscribed" if up else "unsubscribed")
            # On Windows a subscription implies a live central connection,
            # so this is the link signal (BlueZ uses connected AND subscribed).
            self._hub.set_ble_link(up)

        self._loop.call_soon_threadsafe(_update)

    # -- webapp -> phone ---------------------------------------------------

    async def do_notify(self, frame: bytes) -> None:
        if not self._subscribed or self._notify_char is None:
            raise RuntimeError("notify with no subscriber")
        buf = _ibuffer_from_bytes(self._winrt, frame)
        await self._notify_char.notify_value_for_all_subscribed_clients_async(buf)


async def ble_task(hub: WsHub, args) -> None:
    """Keep the WinRT GATT server up; restart the session on failure."""
    winrt = _require_winrt()
    loop = asyncio.get_running_loop()
    backoff = 2.0
    while True:
        server = _WinBleServer(winrt, hub, loop)
        consumer = None
        try:
            await server.start()
            backoff = 2.0
            # Drain the notify queue into the phone, throttled to <=50 Hz.
            consumer = asyncio.create_task(hub.notify_consumer(server.do_notify))
            # Stay up until cancelled or the session faults.
            await asyncio.Future()  # runs forever; cancelled on shutdown
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error(
                "BLE session ended (%s); restarting in %.0fs ...\n%s",
                exc, backoff, traceback.format_exc(),
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)
        finally:
            if consumer is not None:
                consumer.cancel()
            await server.stop()


# --------------------------------------------------------------------------
# Entrypoint (mirrors the Linux bridge)
# --------------------------------------------------------------------------

async def amain(args) -> None:
    hub = WsHub()
    try:
        server = await ws_serve(
            hub.ws_handler,
            args.host,
            args.port,
            process_request=hub.process_request,
            max_size=64,  # frames are tiny; cap inbound message size
        )
    except OSError as exc:
        log.error("FATAL: cannot bind WS port %d on %s: %s", args.port, args.host, exc)
        sys.exit(2)
    log.info("WebSocket + /health listening on %s:%d", args.host, args.port)

    tasks = [asyncio.create_task(stats_loop(hub), name="stats")]
    if args.no_ble:
        log.warning("running with --no-ble: WinRT GATT server disabled (testing only)")
    else:
        tasks.append(asyncio.create_task(ble_task(hub, args), name="ble"))

    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    finally:
        server.close()
        await server.wait_closed()
        for t in tasks:
            t.cancel()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    p = argparse.ArgumentParser(description="Jupiter BLE bridge for Windows (PC as scooter cluster)")
    p.add_argument("--host", default="0.0.0.0", help="WS listen address (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765, help="WS listen port (default 8765)")
    p.add_argument("--no-ble", action="store_true",
                   help="run the WebSocket layer only, no WinRT BLE (for testing)")
    args = p.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        log.info("shutting down")


if __name__ == "__main__":
    main()
