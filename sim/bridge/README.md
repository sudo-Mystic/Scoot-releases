# Jupiter BLE bridge

Makes the Linux laptop look exactly like the real Jupiter scooter's BLE
cluster, and pipes 20-byte Jupiter frames to/from the Scoot Scooter
Simulator webapp over WebSocket. The phone app needs no changes: it
speaks BLE GATT to this bridge exactly as it would to the bike.

```
phone app  <--BLE GATT-->  this bridge  <--WebSocket-->  sim webapp
```

## Safety boundary

The bridge emulates the cluster only: telemetry out over BLE notify,
app writes forwarded in. It does NOT implement lock/unlock/immobilizer/
throttle/brake control and does NOT implement the 0x9A/0xF2/0xF1 auth
challenge-response. An auth frame arriving on the write characteristic
is logged as detected and dropped, never answered.

## Prerequisites

* Linux with BlueZ and a running `bluetoothd` (the sandbox used for
  development has none; the BLE side is only exercised on real hardware).
* A BLE adapter that supports peripheral mode (`bluetoothctl power on`).
* Python 3.10 or newer.
* Run as root, or as a user in the `bluetooth` group with access to the
  system D-Bus.
* `pip install -r requirements.txt` (installs `websockets` and `dbus-next`).

## Run

```sh
cd ~/workspace/scoot-releases/sim/bridge
pip install -r requirements.txt
python3 jupiter-ble-bridge.py
```

Options:

```sh
python3 jupiter-ble-bridge.py --host 0.0.0.0 --port 8765 --adapter hci0
python3 jupiter-ble-bridge.py --no-ble   # WS layer only, no BlueZ (testing)
```

## What success looks like

On startup you should see:

```
INFO jupiter-ble-bridge: WebSocket + /health listening on 0.0.0.0:8765
INFO jupiter-ble-bridge: registering GATT application on /org/bluez/hci0 ...
INFO jupiter-ble-bridge: GATT application registered (service 5456534D-...)
INFO jupiter-ble-bridge: starting advertisement as 'Jupiter-SIM' ...
INFO jupiter-ble-bridge: advertising as 'Jupiter-SIM' with service UUID 5456534D-...
```

When the sim webapp connects and joins:

```
INFO jupiter-ble-bridge: WS connection from ('192.168.1.10', 54321)
INFO jupiter-ble-bridge: sim webapp client joined from ('192.168.1.10', 54321)
```

When the phone connects and subscribes to notify:

```
INFO jupiter-ble-bridge: central connected: /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF
INFO jupiter-ble-bridge: phone subscribed to notify characteristic
INFO jupiter-ble-bridge: BLE phone link UP (connected AND subscribed)
```

Every 30 seconds a stats line is logged:

```
INFO jupiter-ble-bridge: stats rx=120 fwd=120 (no_client=0 bad_len=0) tx=118 (overflow_drop=0) auth_dropped=0 queue=0 ble_link=True
```

Health check (plain HTTP, same port):

```sh
curl http://localhost:8765/health
# {"ok": true, "ble": true}
```

The phone should see a peripheral named `Jupiter-SIM` advertising the
service UUID `5456534D-5647-5341-5342-454E544F5251`, with the write
characteristic `00005352-...` (write, write-without-response) and the
notify characteristic `00005354-...` (notify).

## Wire protocol

* Webapp to bridge, text: `{"t":"join","role":"sim"}`. Single client;
  a new join replaces the old one.
* Bridge to webapp, text: `{"t":"joined"}` on accept, then
  `{"t":"ble","connected":true|false}` for the phone link state.
* Binary, both directions: raw 20-byte Jupiter frames. Phone writes go
  bridge to webapp; webapp frames go to BLE notify (throttled to 50 Hz,
  drop-oldest on overflow). A webapp binary frame that is not exactly
  20 bytes is rejected with `{"t":"error","msg":...}`.
* `GET /health` on the same port returns `{"ok":true,"ble":true|false}`.

## Smoke test (no BlueZ, no root)

```sh
python3 smoke_local.py
```

Asserts the join/joined handshake, 20-byte binary accepted, 19-byte
rejected, `{"t":"ble"}` message shape, `GET /health`, auth frames
detected and dropped, and client replacement on re-join.

## Troubleshooting

* `cannot reach system D-Bus`: the system bus is not available. Start
  dbus (`sudo systemctl start dbus`) and retry. The bridge keeps
  retrying with backoff and keeps the WebSocket side up.
* `adapter hci0 not found`: `bluetoothd` is not running, or no adapter
  is present. Check `bluetoothctl list` and `systemctl status bluetooth`.
* `RegisterApplication failed` / `RegisterAdvertisement failed`: the
  adapter may be powered off (`bluetoothctl power on`), or another
  process is already advertising. Stop other BLE peripheral apps.
* Permission errors on D-Bus: run as root or add your user to the
  `bluetooth` group, then log back in.
* `org.bluez name owner vanished` / bluetoothd restarts: the bridge
  detects this and re-registers the GATT application and the
  advertisement automatically. The WebSocket side stays up throughout.
* Phone connects but no `{"t":"ble","connected":true}`: the link is UP
  only when the phone is connected AND subscribed to the notify
  characteristic. Check the app subscribes to `00005354-...`.
* Webapp binary rejected (`t=error`): frames must be exactly 20 bytes.
