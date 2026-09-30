# Scoot Scooter Simulator: Safety Boundaries

Read this before operating the simulator. These boundaries are
non-negotiable. They come from the standing project safety rule: Scoot is
telemetry, display, and mirroring only.

## 1. What the simulator is

The simulator emulates the TVS Jupiter cluster's telemetry and display
behavior only. It produces the same bytes a real cluster would send
(0x10/0x11/0x18/0x19/0x6B frames), and it renders what a real cluster
would display from app-sent frames (clock, text rows, caller info,
navigation). Nothing more.

The BLE bridge (`sim/bridge/jupiter-ble-bridge.py`) is part of that
emulation: it is a BlueZ GATT server on the laptop that advertises the
real Jupiter service UUID and the real write/notify characteristics, so
the stock app can connect to it over BLE exactly as it connects to the
real cluster. The bridge only answers GATT reads, writes, and notifies
like the real module does. It invents no new characteristics and no new
frame types.

## 2. What it can never do

The simulator and the bridge have no code path, control, or frame that
can do any of the following, on a real vehicle or a simulated one:

1. Lock or unlock anything.
2. Immobilize a vehicle or cut ignition.
3. Apply throttle or brakes.
4. Move the Key switch. The Key switch is the simulated physical key. Only
   the sim operator flips it in the control deck. No frame from the app
   can change it, because no app builder sets ignition state on the
   cluster; ignition is reported by the cluster, never commanded.
5. Answer the 0x9A/0xF2 auth challenge. The app detects the challenge for
   diagnostics only. It never builds or sends a response.
6. Construct 0x9A/0xF2/0xF1 auth responses. The keyless-entry and
   vehicle-control channel is detect-only by design, in the app, in the
   sim, and in the bridge.

If a future change proposes adding any of the above, stop and get explicit
approval first. The default answer is no.

## 3. The sim never touches a real scooter

1. The bridge has no radio path to real hardware. It talks to one phone
   over BLE (the phone running the Scoot app) and to the sim webapp over
   a LAN WebSocket. No real scooter is involved anywhere in the chain.
2. The Scoot app runs stock, unmodified. The app cannot tell the
   simulator from the real scooter; that is the point of the exercise.
   The operator always knows which one is connected, because the
   operator started the bridge.
3. The stock TVS Connect app cannot use the simulator.
4. Test results from the sim are sim results. Do not present them as
   real-bike data. Frame layouts marked UNVERIFIED in `PROTOCOL.md` stay
   unverified until a real hardware capture confirms them.

## 4. The hidden URL is unlisted, not access-controlled

1. The sim page is served from an unlisted path
   (`https://sudo-mystic.github.io/Scoot-releases/sim/`). Hiding relies on
   three things: `<meta name="robots" content="noindex, nofollow">` on the
   page, no `sim/` entry in `sitemap.xml`, and no public links to it.
   `robots.txt` is deliberately left untouched.
2. Unlisted is not private. There is no login. Anyone with the link can
   open the page.
3. Do not share the link publicly. Do not link it from public pages,
   posts, or issues. Share it directly with collaborators only.

## 5. Operating rules

1. Do not expose the bridge (port 8765) to the internet. It is a LAN-only
   dev server with no authentication.
2. The bridge advertises a Jupiter service over BLE. Do not run it where
   a real Jupiter cluster could be within range of a connected phone at
   the same time; avoid confusion about which device the app is talking
   to.
3. Do not use the simulator to mislead anyone about what was tested or on
   what hardware.
4. If you see a safety problem, a bypass, or a frame path that should not
   exist, stop operating the sim and report it to Rishabh before
   continuing.

## 6. Summary for anyone new

The sim is a fake cluster on a screen, with a fake cluster radio on the
laptop. It shows numbers and pictures. It cannot touch a real scooter,
lock anything, or move the key. The link is unlisted but has no lock on
the door, so do not hand out the address.
