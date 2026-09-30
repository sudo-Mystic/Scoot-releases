#!/usr/bin/env python3
"""
Jupiter BLE bridge: makes the Linux laptop look exactly like the real
TVS Jupiter scooter's BLE cluster, and pipes 20-byte Jupiter frames
to/from the Scoot Scooter Simulator webapp over WebSocket.

Architecture (no app changes): the phone app speaks BLE GATT to this
bridge; the bridge forwards app writes to the sim webapp and notifies
sim telemetry frames back to the phone.

    phone app  <--BLE GATT-->  this bridge  <--WebSocket-->  sim webapp

SAFETY BOUNDARY (non-negotiable):
  The bridge emulates the cluster only: telemetry out over BLE notify,
  app writes forwarded in. It NEVER implements lock/unlock/immobilizer/
  throttle/brake control and NEVER implements the 0x9A/0xF2/0xF1 auth
  challenge-response. An auth frame arriving on the write characteristic
  is logged as detected (like the app does) and dropped, never answered.

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

Run:  python3 jupiter-ble-bridge.py [--host 0.0.0.0] [--port 8765]
      [--adapter hci0] [--no-ble]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time

from websockets import Headers, Request, Response
from websockets.asyncio.server import ServerConnection, serve as ws_serve

log = logging.getLogger("jupiter-ble-bridge")

# --------------------------------------------------------------------------
# Constants
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

APP_PATH = "/com/scoot/bridge"
APP_SERVICE_PATH = APP_PATH + "/service0"
APP_WRITE_CHAR_PATH = APP_SERVICE_PATH + "/char_write"
APP_NOTIFY_CHAR_PATH = APP_SERVICE_PATH + "/char_notify"
APP_ADV_PATH = APP_PATH + "/advertisement0"

BLUEZ = "org.bluez"
DBUS = "org.freedesktop.DBus"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
ADV_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
DEVICE_IFACE = "org.bluez.Device1"


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


# --------------------------------------------------------------------------
# BLE layer (BlueZ D-Bus GATT server). dbus-next is imported lazily so the
# WS layer above stays importable/testable without BlueZ.
# --------------------------------------------------------------------------

def _require_dbus_next():
    try:
        import dbus_next
        from dbus_next import BusType
        from dbus_next.aio import MessageBus
        from dbus_next.message import Message, MessageType
        from dbus_next.service import PropertyAccess, ServiceInterface, dbus_property, method
        return dbus_next, BusType, MessageBus, Message, MessageType, PropertyAccess, ServiceInterface, dbus_property, method
    except ImportError:
        log.error(
            "FATAL: dbus-next is not installed. Run: pip install -r requirements.txt "
            "(or pip install dbus-next websockets)."
        )
        sys.exit(2)


def _props_dict(iface, ServiceInterface):
    """Build the {interface: {prop: Variant}} dict for GetManagedObjects."""
    props = {}
    for prop in ServiceInterface._get_properties(iface):
        try:
            value = getattr(iface, prop.name)
        except Exception:
            continue
        from dbus_next import Variant
        props[prop.name] = Variant(prop.signature, value)
    return {iface.name: props}


class _BleApp:
    """BlueZ GATT application + advertisement, built on dbus-next.

    One instance per registration attempt; created inside ble_supervisor()
    after the lazy dbus-next import.
    """

    def __init__(self, dn, hub: WsHub):
        (_dbus_next, self.BusType, self.MessageBus, self.Message,
         self.MessageType, self.PropertyAccess, self.ServiceInterface,
         self.dbus_property, self.method) = dn
        self.hub = hub
        self.centrals: set[str] = set()  # Device1 paths currently connected
        self._build_interfaces()

    # -- interface definitions (need the decorators from the lazy import) -

    def _build_interfaces(self):
        dn = self
        method = self.method
        dbus_property = self.dbus_property
        PropertyAccess = self.PropertyAccess
        ServiceInterface = self.ServiceInterface

        class Application(ServiceInterface):
            def __init__(self, managed):
                super().__init__("org.freedesktop.DBus.ObjectManager")
                self._managed = managed

            @method()
            def GetManagedObjects(self) -> "a{oa{sa{sv}}}":  # noqa: F821
                objs = {}
                for path, ifaces in self._managed:
                    entry = {}
                    for iface in ifaces:
                        entry.update(_props_dict(iface, ServiceInterface))
                    objs[path] = entry
                return objs

        class GattService(ServiceInterface):
            def __init__(self, path, uuid):
                super().__init__("org.bluez.GattService1")
                self.path = path
                self._uuid = uuid

            @dbus_property(PropertyAccess.READ)
            def UUID(self) -> "s":  # noqa: F821
                return self._uuid

            @dbus_property(PropertyAccess.READ)
            def Primary(self) -> "b":  # noqa: F821
                return True

        class GattCharacteristic(ServiceInterface):
            def __init__(self, path, uuid, flags, service_path):
                super().__init__("org.bluez.GattCharacteristic1")
                self.path = path
                self._uuid = uuid
                self._flags = flags
                self._service_path = service_path

            @dbus_property(PropertyAccess.READ)
            def UUID(self) -> "s":  # noqa: F821
                return self._uuid

            @dbus_property(PropertyAccess.READ)
            def Service(self) -> "o":  # noqa: F821
                return self._service_path

            @dbus_property(PropertyAccess.READ)
            def Flags(self) -> "as":  # noqa: F821
                return self._flags

        hub = self.hub
        link_updater = self._update_link

        class WriteCharacteristic(GattCharacteristic):
            def __init__(self, path, service_path):
                super().__init__(path, WRITE_CHAR_UUID,
                                 ["write", "write-without-response"], service_path)

            @method()
            def WriteValue(self, value: "ay", options: "a{sv}"):  # noqa: F821
                frame = bytes(value)
                if len(frame) != FRAME_LEN:
                    hub.rx_dropped_bad_len += 1
                    log.warning("BLE write of %d bytes ignored (need %d)", len(frame), FRAME_LEN)
                    return
                asyncio.get_running_loop().create_task(hub.publish_ble_write(frame))

        class NotifyCharacteristic(GattCharacteristic):
            def __init__(self, path, service_path):
                super().__init__(path, NOTIFY_CHAR_UUID, ["notify"], service_path)
                self._value = b""
                self._subscribers = 0

            @dbus_property(PropertyAccess.READ)
            def Value(self) -> "ay":  # noqa: F821
                return self._value

            @method()
            def StartNotify(self):
                self._subscribers += 1
                log.info("phone subscribed to notify characteristic")
                link_updater()

            @method()
            def StopNotify(self):
                self._subscribers = max(0, self._subscribers - 1)
                if self._subscribers == 0:
                    log.info("phone unsubscribed from notify characteristic")
                link_updater()

            @property
            def notifying(self):
                return self._subscribers > 0

            async def do_notify(self, frame: bytes):
                if not self.notifying:
                    raise RuntimeError("notify with no subscriber")
                self._value = frame
                self.emit_properties_changed({"Value": frame})

        service = GattService(APP_SERVICE_PATH, SERVICE_UUID)
        write_char = WriteCharacteristic(APP_WRITE_CHAR_PATH, APP_SERVICE_PATH)
        notify_char = NotifyCharacteristic(APP_NOTIFY_CHAR_PATH, APP_SERVICE_PATH)

        class Advertisement(ServiceInterface):
            def __init__(self, path):
                super().__init__("org.bluez.LEAdvertisement1")
                self.path = path

            @method()
            def Release(self):
                log.info("advertisement released by BlueZ")

            @dbus_property(PropertyAccess.READ)
            def Type(self) -> "s":  # noqa: F821
                return "peripheral"

            @dbus_property(PropertyAccess.READ)
            def ServiceUUIDs(self) -> "as":  # noqa: F821
                return [SERVICE_UUID]

            @dbus_property(PropertyAccess.READ)
            def LocalName(self) -> "s":  # noqa: F821
                return LOCAL_NAME

            @dbus_property(PropertyAccess.READ)
            def Includes(self) -> "as":  # noqa: F821
                return []

        advertisement = Advertisement(APP_ADV_PATH)

        managed = [
            (APP_SERVICE_PATH, [service]),
            (APP_WRITE_CHAR_PATH, [write_char]),
            (APP_NOTIFY_CHAR_PATH, [notify_char]),
        ]
        self.application = Application(managed)
        self.advertisement = advertisement
        self.notify_char = notify_char
        self._ifaces = {
            APP_PATH: [self.application],
            APP_SERVICE_PATH: [service],
            APP_WRITE_CHAR_PATH: [write_char],
            APP_NOTIFY_CHAR_PATH: [notify_char],
            APP_ADV_PATH: [advertisement],
        }

    def _update_link(self):
        # Phone link is UP only when a central is connected AND subscribed.
        up = bool(self.centrals) and self.notify_char.notifying
        self.hub.set_ble_link(up)

    def export(self, bus):
        for path, ifaces in self._ifaces.items():
            for iface in ifaces:
                bus.export(path, iface)

    def handle_message(self, msg) -> bool:
        """D-Bus signal handler: track central connects/disconnects and
        org.bluez restarts. Returns False so other handlers still run."""
        if msg.message_type != self.MessageType.SIGNAL:
            return False
        if (msg.interface == PROPS_IFACE and msg.member == "PropertiesChanged"
                and msg.body and msg.body[0] == DEVICE_IFACE):
            changed = msg.body[1]
            if "Connected" in changed:
                connected = changed["Connected"].value
                if connected:
                    self.centrals.add(msg.path)
                    log.info("central connected: %s", msg.path)
                else:
                    self.centrals.discard(msg.path)
                    log.info("central disconnected: %s", msg.path)
                self._update_link()
        return False


async def _call(bus, destination, path, interface, member, signature="", body=None):
    from dbus_next.message import Message
    reply = await bus.call(Message(
        destination=destination, path=path, interface=interface,
        member=member, signature=signature, body=body or [],
    ))
    if reply.message_type.name != "METHOD_RETURN":
        raise RuntimeError("D-Bus call %s.%s failed: %s" % (interface, member, reply.body))
    return reply


async def ble_supervisor(hub: WsHub, args) -> None:
    """Keep the BlueZ GATT server registered; re-register on churn."""
    dn = _require_dbus_next()
    _dbus_next, BusType, MessageBus, Message, MessageType, *_ = dn

    backoff = 2.0
    while True:
        try:
            bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        except Exception as exc:
            log.error(
                "cannot reach system D-Bus (%s). Is dbus running? "
                "Retrying in %.0fs...", exc, backoff,
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)
            continue
        backoff = 2.0

        try:
            await _run_ble_session(dn, bus, hub, args)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("BLE session ended (%s); re-registering...", exc)
        try:
            bus.disconnect()
        except Exception:
            pass
        await asyncio.sleep(2.0)


async def _run_ble_session(dn, bus, hub: WsHub, args) -> None:
    _dbus_next, BusType, MessageBus, Message, MessageType, *_rest = dn
    adapter_path = "/org/bluez/%s" % args.adapter

    # The adapter must exist: powered BLE hardware.
    try:
        introspection = await bus.introspect(BLUEZ, adapter_path)
    except Exception as exc:
        raise RuntimeError(
            "adapter %s not found (%s). Is bluetoothd running, is the "
            "adapter present and powered? Try: bluetoothctl power on" % (args.adapter, exc)
        )
    adapter_obj = bus.get_proxy_object(BLUEZ, adapter_path, introspection)
    try:
        gatt_mgr = adapter_obj.get_interface(GATT_MANAGER_IFACE)
    except Exception:
        raise RuntimeError(
            "adapter %s has no %s: is the controller powered and does it "
            "support BLE peripheral mode? Try: bluetoothctl power on" % (args.adapter, GATT_MANAGER_IFACE)
        )
    adv_mgr = adapter_obj.get_interface(ADV_MANAGER_IFACE)

    app = _BleApp(dn, hub)
    app.export(bus)
    bus.add_message_handler(app.handle_message)

    # Watch Device1 Connected changes (central connect/disconnect) and
    # org.bluez name ownership (bluetoothd restart).
    await _call(bus, DBUS, "/org/freedesktop/DBus", DBUS, "AddMatch", "s", [
        "type='signal',sender='%s',interface='%s',member='PropertiesChanged',"
        "path_namespace='%s'" % (BLUEZ, PROPS_IFACE, adapter_path),
    ])
    await _call(bus, DBUS, "/org/freedesktop/DBus", DBUS, "AddMatch", "s", [
        "type='signal',sender='%s',interface='%s',member='NameOwnerChanged',"
        "arg0='%s'" % (DBUS, DBUS, BLUEZ),
    ])

    bluez_gone = asyncio.Event()

    def _watch_name_owner(msg) -> bool:
        if (msg.message_type == MessageType.SIGNAL and msg.interface == DBUS
                and msg.member == "NameOwnerChanged" and msg.body
                and msg.body[0] == BLUEZ and len(msg.body) >= 3 and not msg.body[2]):
            log.warning("bluetoothd restarted (org.bluez name lost); will re-register")
            bluez_gone.set()
        return False

    bus.add_message_handler(_watch_name_owner)

    try:
        log.info("registering GATT application on %s ...", adapter_path)
        await gatt_mgr.call_register_application(APP_PATH, {})
        log.info("GATT application registered (service %s)", SERVICE_UUID)
    except Exception as exc:
        raise RuntimeError("RegisterApplication failed: %s" % exc)

    try:
        log.info("starting advertisement as %r ...", LOCAL_NAME)
        await adv_mgr.call_register_advertisement(APP_ADV_PATH, {})
        log.info("advertising as %r with service UUID %s", LOCAL_NAME, SERVICE_UUID)
    except Exception as exc:
        # Some adapters reject advertisements while another advertises.
        log.error("RegisterAdvertisement failed: %s", exc)
        try:
            await gatt_mgr.call_unregister_application(APP_PATH)
        except Exception:
            pass
        raise

    # Drain the notify queue into the phone, throttled to <=50 Hz.
    consumer = asyncio.create_task(hub.notify_consumer(app.notify_char.do_notify))

    # Seed central set from already-connected devices.
    try:
        await _seed_connected_centrals(bus, app, adapter_path)
    except Exception as exc:
        log.debug("could not seed connected centrals: %s", exc)

    try:
        while True:
            # Poll as a backstop: if we lost the bus or bluetoothd died
            # without the NameOwnerChanged signal reaching us, re-register.
            await asyncio.sleep(15.0)
            if bluez_gone.is_set():
                raise RuntimeError("bluetoothd restarted")
            alive = await _name_has_owner(bus, BLUEZ)
            if not alive:
                raise RuntimeError("org.bluez name owner vanished")
    finally:
        consumer.cancel()
        try:
            await adv_mgr.call_unregister_advertisement(APP_ADV_PATH)
        except Exception:
            pass
        try:
            await gatt_mgr.call_unregister_application(APP_PATH)
        except Exception:
            pass
        hub.set_ble_link(False)


async def _name_has_owner(bus, name: str) -> bool:
    try:
        reply = await _call(bus, DBUS, "/org/freedesktop/DBus", DBUS,
                            "NameHasOwner", "s", [name])
        return bool(reply.body and reply.body[0])
    except Exception:
        return False


async def _seed_connected_centrals(bus, app, adapter_path: str) -> None:
    reply = await _call(bus, BLUEZ, "/org/bluez", "org.freedesktop.DBus.ObjectManager",
                        "GetManagedObjects")
    objs = reply.body[0] if reply.body else {}
    for path, ifaces in objs.items():
        if not str(path).startswith(adapter_path + "/dev_"):
            continue
        dev = ifaces.get(DEVICE_IFACE, {})
        if dev.get("Connected") and dev["Connected"].value:
            app.centrals.add(str(path))
    app._update_link()


# --------------------------------------------------------------------------
# Entrypoint
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
        log.warning("running with --no-ble: BlueZ GATT server disabled (testing only)")
    else:
        tasks.append(asyncio.create_task(ble_supervisor(hub, args), name="ble"))

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
    p = argparse.ArgumentParser(description="Jupiter BLE bridge (laptop as scooter cluster)")
    p.add_argument("--host", default="0.0.0.0", help="WS listen address (default 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765, help="WS listen port (default 8765)")
    p.add_argument("--adapter", default="hci0", help="BlueZ adapter (default hci0)")
    p.add_argument("--no-ble", action="store_true",
                   help="run the WebSocket layer only, no BlueZ (for testing)")
    args = p.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        log.info("shutting down")


if __name__ == "__main__":
    main()
