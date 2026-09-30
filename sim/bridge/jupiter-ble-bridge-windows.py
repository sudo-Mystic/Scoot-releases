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
WebSocket wire protocol is IDENTICAL (same WsHub class, imported from the
Linux file), so the sim webapp cannot tell which bridge it is talking to.
Only the BLE layer differs: Windows has no D-Bus/BlueZ, so the GATT
server is built on the WinRT GattServiceProvider API (package: winrt)
plus a BluetoothLEAdvertisementPublisher for the "Jupiter-SIM"
advertisement carrying the real Jupiter service UUID.

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
  pip install -r requirements-windows.txt   (websockets + winrt)

Run:  python .\\jupiter-ble-bridge-windows.py [--host 0.0.0.0] [--port 8765] [--no-ble]
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import logging
import os
import sys
from uuid import UUID

log = logging.getLogger("jupiter-ble-bridge")

# --------------------------------------------------------------------------
# Shared WebSocket hub (identical wire protocol to the Linux bridge).
# jupiter-ble-bridge.py is imported as a module; its dbus-next dependency
# is lazy (only touched by ble_supervisor), so importing it on Windows
# is safe.
# --------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_LINUX_BRIDGE = os.path.join(_HERE, "jupiter-ble-bridge.py")


def _load_shared():
    if not os.path.exists(_LINUX_BRIDGE):
        log.error("FATAL: %s not found next to this script.", _LINUX_BRIDGE)
        sys.exit(2)
    spec = importlib.util.spec_from_file_location("jupiter_ble_bridge", _LINUX_BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except ImportError as exc:
        log.error("FATAL: shared bridge module needs %s. Run: pip install websockets", exc)
        sys.exit(2)
    return mod


_base = _load_shared()
WsHub = _base.WsHub
stats_loop = _base.stats_loop
SERVICE_UUID = _base.SERVICE_UUID
WRITE_CHAR_UUID = _base.WRITE_CHAR_UUID
NOTIFY_CHAR_UUID = _base.NOTIFY_CHAR_UUID
LOCAL_NAME = _base.LOCAL_NAME
FRAME_LEN = _base.FRAME_LEN


# --------------------------------------------------------------------------
# BLE layer (WinRT GattServiceProvider). winrt is imported lazily so the
# WS layer above stays importable/testable without it.
# --------------------------------------------------------------------------

def _require_winrt():
    try:
        from winrt.windows.devices.bluetooth import BluetoothError
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
            "FATAL: the 'winrt' package is not installed. "
            "Run: pip install -r requirements-windows.txt (or pip install winrt websockets)."
        )
        sys.exit(2)


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
        result = await w["GattServiceProvider"].create_async(UUID(SERVICE_UUID))
        if result.error != w["BluetoothError"].SUCCESS:
            raise RuntimeError("GattServiceProvider.create_async failed: %s" % result.error)
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
        wres = await self._provider.create_characteristic_async(UUID(WRITE_CHAR_UUID), wp)
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
        nres = await self._provider.create_characteristic_async(UUID(NOTIFY_CHAR_UUID), np)
        if nres.error != w["BluetoothError"].SUCCESS:
            raise RuntimeError("create notify characteristic failed: %s" % nres.error)
        self._notify_char = nres.characteristic
        self._tokens.append(
            self._notify_char.add_subscribed_clients_changed(self._on_subscribed_changed)
        )
        log.info("notify characteristic ready (%s)", NOTIFY_CHAR_UUID)

        # Advertisement: local name + service UUID, like the BlueZ one.
        self._publisher = w["BluetoothLEAdvertisementPublisher"]()
        adv = self._publisher.advertisement
        adv.local_name = LOCAL_NAME
        adv.service_uuids.append(UUID(SERVICE_UUID))
        self._publisher.start()
        if self._publisher.status != w["BluetoothLEAdvertisementPublisherStatus"].STARTED:
            raise RuntimeError(
                "BLE advertisement did not start (status=%s). Does this PC's "
                "Bluetooth radio support BLE peripheral mode?" % self._publisher.status
            )
        log.info("advertising as %r with service UUID %s", LOCAL_NAME, SERVICE_UUID)

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
            log.error("BLE session ended (%s); restarting in %.0fs ...", exc, backoff)
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
        from websockets.asyncio.server import serve as ws_serve

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
