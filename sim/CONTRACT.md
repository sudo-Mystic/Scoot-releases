# Scoot Simulator module contract (internal)

This is the integration contract between the shell (W6), engine (W3),
transport (W4), and UI panels (W7-W10). The shell imports everything
owned by other workers defensively: if a module is missing, its panel
is skipped and the rest keeps running.

## 1. UI panel modules

Every panel module MUST export:

```js
export function mount(rootEl, ctx) { /* ... */ }
```

- `rootEl`: the DOM element the panel renders into. The panel owns this
  subtree only; never touch elements outside it.
- `ctx = { engine, transport, bus }`:
  - `engine`: engine instance (W3), or `null` if not landed yet.
  - `transport`: transport instance (W4), or `null` if not landed yet.
  - `bus`: shared event emitter, always present.

Panels:

| Panel     | Module                | Owner | Root in index.html                    |
|-----------|-----------------------|-------|---------------------------------------|
| cluster   | `./ui/cluster.js`     | W7    | `[data-panel="cluster"] [data-mount]`  |
| controls  | `./ui/controls.js`    | W8    | `[data-panel="controls"] [data-mount]` |
| scenarios | `./ui/scenarios.js`   | W10   | `[data-panel="scenarios"] [data-mount]`|
| lab       | `./ui/lab.js`         | W9    | `[data-panel="lab"] [data-mount]`      |

Panels MUST NOT talk to each other directly. Cross-panel messages go
through `bus`. Panels MUST NOT call engine internals; use the engine API
below.

## 2. Engine API (W3 owns `src/engine/index.js`)

```js
import { createEngine } from './engine/index.js';
const engine = createEngine({ profile } = {});
```

- `engine.tick(dtMs)` - advance simulation state by `dtMs` milliseconds.
  The shell calls this every 50 ms.
- `engine.receiveFromApp(frame)` - feed one inbound frame (Uint8Array,
  20 bytes) from the app into the simulator.
- `engine.on('frame', (frame) => ...)` - emitted for every OUTBOUND
  frame the simulator sends toward the app (Uint8Array, 20 bytes).
  The shell forwards these to `transport.sendFrame`.
- `engine.on(event, fn)` / `engine.off(event, fn)` - standard subscribe.
- `engine.getState()` - plain-object snapshot of cluster state for
  panels that render from a snapshot instead of events.

### Engine-decode events (frame routing, W1 protocol-spec)

Inbound frames are decoded per `docs/PROTOCOL.md`. The engine MUST
surface these as named events so panels can render them without parsing
raw bytes:

- `navtext` - app sent `0x4F` navigation text.
  - Payload: `{ text: string }`.
  - Decode: start byte `0x5B`, data ID `0x4F`, text in bytes 2-18
    (up to 17 bytes), `0x00` padding stripped, `0xFF` terminator.
    Sanitize to ASCII with word-boundary preference (stock hard-cuts
    17 chars with no sanitization; the simulator mirrors Scoot's
    ASCII fallback). See PROTOCOL.md section "0x4F Navigation text".
  - Cluster (W7) MUST render the latest `navtext` on its nav screen
    and on the text/message screen where applicable. Older text is
    superseded by newer (nav instruction bursts arrive ~200 ms apart;
    newer wins).
- `brightness` - app sent `0x5A` sub-command `0xF1` vehicle control.
  - Payload: `{ level: 1..5 }`.
  - Decode: start byte `0x5A`, data ID `0xF1`, wire byte at index 2:
    `1` -> level 1, otherwise level = wire byte / 2 (levels 2-5 map to
    wire bytes 4, 6, 8, 10; clamp 1-5). See PROTOCOL.md "0x5A 0xF1
    Vehicle control".
  - Cluster MAY reflect this subtly (e.g. dim the canvas backdrop).
    Safely ignoring it is also acceptable. It MUST NOT affect engine
    physics or frame emission.

## 3. Transport API (W4 owns `src/transport.js`)

```js
import { createTransport } from './transport.js';
const transport = createTransport({ url } = {});
```

- `transport.sendFrame(frame)` - send one outbound Uint8Array frame
  (20 bytes) to the bridge (app side).
- `transport.on('frame', (frame) => ...)` - emitted for every INBOUND
  frame arriving from the bridge. The shell forwards these to
  `engine.receiveFromApp`.
- `transport.on('status', (state) => ...)` - `state` is one of
  `'connecting' | 'connected' | 'disconnected' | 'error'`. The shell
  drives the top-bar link pill from this.
- `transport.connect()` / `transport.disconnect()` - lifecycle.
- `transport.isConnected()` - boolean.

Frames on the wire are raw 20-byte `Uint8Array`s, exactly the framing in
`docs/PROTOCOL.md`. Transport does NO frame parsing.

## 4. Bus events

`bus` (`src/bus.js`, `createBus()`) is a tiny emitter:
`on(event, fn) -> unsubscribe`, `off`, `once`, `emit(event, payload)`.
Handler exceptions are caught and logged, never propagated.

Reserved event names:

| Event         | Payload              | Emitter        |
|---------------|----------------------|----------------|
| `ready`       | `{ ctx }`            | shell          |
| `link`        | `{ state }`          | shell          |
| `frame-count` | none                 | any panel/lab  |
| `navtext`     | `{ text }`           | engine -> panels (see 2) |
| `brightness`  | `{ level }`          | engine -> panels (see 2) |
| `scenario`    | `{ name, step }`     | scenarios panel|

Panels MAY emit their own `panel:<key>:<event>` namespaced events for
panel-specific traffic. Do not emit bare engine event names from panels.

## 5. Design rules (binding on all panels)

- Dark-tech cockpit: mono numerals, 1px dividers (`--line`), no card
  soup. Accent is volt lime `--accent: #c8ff00` from `styles/tokens.css`;
  it is the ONLY accent color in the app. Lock it: audit every component.
- No Inter. Mono stack only (`--font-mono`); UI labels use `--font-ui`
  system stack. No Google Fonts links.
- No emojis in UI. No em dashes in copy.
- Motion: live values, status LEDs, and the cluster canvas only. Honor
  `prefers-reduced-motion` (app.css already gates LED animation).
- Responsive: panels stack single-column under 768px (shell grid
  handles this; panels must not assume fixed widths).
- Shared primitives live in `styles/app.css`: `.btn`, `.kv`, `.field`,
  `.panel-head`, `.link-pill`, `.led`.
