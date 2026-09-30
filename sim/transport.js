/*
 * Webapp-side transport for the Jupiter BLE bridge (protocol v2).
 * Owned by W4. No DOM, no dependencies. Works wherever the WebSocket
 * global exists (browsers, Node 18+).
 *
 * The bridge (sim/bridge/jupiter-ble-bridge.py) makes the laptop look
 * like the real Jupiter scooter over BLE and pipes raw 20-byte Jupiter
 * frames to/from this webapp over WebSocket.
 *
 *   import { createTransport } from './transport.js';
 *   const t = createTransport({ url: 'ws://192.168.1.5:8765' });
 *   t.on('frame', (bytes) => { ... });  // Uint8Array(20) written by the phone app
 *   t.on('ble', (link) => { ... });     // { connected: bool }, phone BLE link state
 *   t.on('status', (s) => { ... });     // 'connecting' | 'open' | 'closed' | 'error'
 *   t.connect();
 *   t.sendFrame(new Uint8Array(20));    // returns true if sent, false if dropped
 *   t.disconnect();
 *
 * Wire protocol (exact):
 *   webapp -> bridge text: {"t":"join","role":"sim"} (single client; a new
 *     join replaces the old one)
 *   bridge -> webapp text: {"t":"joined"} on accept;
 *     {"t":"ble","connected":true|false} for the phone link state
 *   binary, both directions: raw 20-byte Jupiter frames. A webapp binary
 *     frame that is not exactly 20 bytes is rejected by the bridge.
 *
 * Auto-reconnects with backoff after an unexpected close. Transport does
 * NO frame parsing: frames on the wire are raw 20-byte Uint8Arrays.
 *
 * Extras beyond the core API (additive, safe to ignore):
 *   - url defaults to the page's own origin when the page is served over
 *     http(s) on port 8765 (covers --serve style hosting where the bridge
 *     serves the sim page itself). Otherwise url is required.
 *   - room is accepted for API compatibility but ignored: the bridge has
 *     no room concept (single client). The join payload is exactly
 *     {"t":"join","role":"sim"}.
 *   - on('peer') is kept for API compatibility but always reports false:
 *     the bridge has no relay-peer concept; phone presence arrives via
 *     on('ble') instead.
 *   - t.isConnected(): bool, true while the socket is open.
 *   - t.setUrl(url) (aliases: t.setBridgeUrl, t.setRelayUrl): change the
 *     bridge URL; takes effect on the next connect(). t.getUrl(): the
 *     current URL.
 *   - on() returns an unsubscribe function. on('ble') fires once
 *     immediately with the current link state so UI can render on subscribe.
 */

const ROOM_RE = /^[A-Z0-9]{6}$/;
const FRAME_LEN = 20;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;

function pageLocation() {
  if (typeof window !== 'undefined' && window.location) return window.location;
  if (typeof location !== 'undefined' && location) return location;
  return null;
}

function defaultUrl() {
  const loc = pageLocation();
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.port === '8765') {
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc.host}/`;
  }
  return null;
}

export function createTransport({ url = defaultUrl(), room = null, role = 'sim' } = {}) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('createTransport: url is required (ws:// or wss://)');
  }
  if (room !== null && (typeof room !== 'string' || !ROOM_RE.test(room))) {
    throw new TypeError('createTransport: room must be 6 characters A-Z 0-9');
  }
  if (role !== 'sim' && role !== 'app') {
    throw new TypeError('createTransport: role must be "sim" or "app"');
  }
  if (typeof WebSocket === 'undefined') {
    throw new Error('createTransport: WebSocket global is not available in this environment');
  }

  const listeners = { frame: new Set(), peer: new Set(), status: new Set(), ble: new Set() };
  let ws = null;
  let manualClose = false;
  let retries = 0;
  let timer = null;
  let bleUp = false;
  let bridgeUrl = url;
  let currentRoom = room; // accepted for compatibility; the bridge ignores it

  function emitBle() {
    emit('ble', { connected: bleUp });
  }

  function emit(event, value) {
    for (const cb of Array.from(listeners[event])) {
      try {
        cb(value);
      } catch (err) {
        // Never let a listener break the transport; surface async.
        setTimeout(() => {
          throw err;
        }, 0);
      }
    }
  }

  function sendJoin(sock) {
    // Exact bridge wire payload: no room field.
    sock.send(JSON.stringify({ t: 'join', role }));
  }

  function scheduleReconnect() {
    if (manualClose) return;
    clearTimeout(timer);
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retries) + Math.random() * 250;
    retries += 1;
    timer = setTimeout(connect, delay);
  }

  function connect() {
    manualClose = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    emit('status', 'connecting');
    let sock;
    try {
      sock = new WebSocket(bridgeUrl);
    } catch (err) {
      emit('status', 'error');
      scheduleReconnect();
      return;
    }
    ws = sock;
    try {
      sock.binaryType = 'arraybuffer';
    } catch (err) {
      /* binaryType is optional */
    }
    sock.onopen = () => {
      retries = 0;
      emit('status', 'open');
      sendJoin(sock);
    };
    sock.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        let msg = null;
        try {
          msg = JSON.parse(data);
        } catch (err) {
          return;
        }
        if (msg && msg.t === 'ble') {
          const up = Boolean(msg.connected);
          if (up !== bleUp) {
            bleUp = up;
            emitBle();
          }
        } else if (msg && msg.t === 'error' && typeof console !== 'undefined') {
          console.warn('[jupiter-bridge] server error:', msg.msg);
        }
        // 'joined' is informational; nothing to do.
        return;
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.length !== FRAME_LEN) {
        if (typeof console !== 'undefined') {
          console.warn(`[jupiter-bridge] dropped ${bytes.length}-byte frame (need ${FRAME_LEN})`);
        }
        return;
      }
      emit('frame', bytes);
    };
    sock.onerror = () => emit('status', 'error');
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (bleUp) {
        bleUp = false;
        emitBle();
      }
      emit('status', 'closed');
      scheduleReconnect();
    };
  }

  function disconnect() {
    manualClose = true;
    clearTimeout(timer);
    timer = null;
    if (ws) {
      const sock = ws;
      ws = null;
      try {
        sock.close();
      } catch (err) {
        /* ignore */
      }
    }
  }

  // Kept for API compatibility. The bridge has no room concept, so this
  // only records the value and re-sends the join when open.
  function join(nextRoom) {
    if (typeof nextRoom !== 'string' || !ROOM_RE.test(nextRoom)) {
      throw new TypeError('join: room must be 6 characters A-Z 0-9');
    }
    currentRoom = nextRoom;
    if (ws && ws.readyState === WebSocket.OPEN) sendJoin(ws);
  }

  function isConnected() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  // Returns true when the frame went out, false when dropped because the
  // socket is not open. Throws on a bad frame length (programmer error,
  // fail fast).
  function sendFrame(bytes20) {
    const bytes = bytes20 instanceof Uint8Array ? bytes20 : Uint8Array.from(bytes20 || []);
    if (bytes.length !== FRAME_LEN) {
      throw new TypeError(`sendFrame: frame must be exactly ${FRAME_LEN} bytes, got ${bytes.length}`);
    }
    if (!isConnected()) return false;
    ws.send(bytes);
    return true;
  }

  // Change the bridge URL. Takes effect on the next connect(); a live
  // socket keeps using the old URL until it is closed and reopened.
  function setUrl(nextUrl) {
    if (typeof nextUrl !== 'string' || nextUrl.length === 0) {
      throw new TypeError('setUrl: url is required (ws:// or wss://)');
    }
    bridgeUrl = nextUrl;
  }

  function getUrl() {
    return bridgeUrl;
  }

  function on(event, cb) {
    if (!listeners[event]) {
      throw new TypeError(`unknown event "${event}" (expected frame, peer, status or ble)`);
    }
    if (typeof cb !== 'function') throw new TypeError('on: callback must be a function');
    listeners[event].add(cb);
    if (event === 'peer') cb(false); // bridge has no relay-peer concept
    if (event === 'ble') cb({ connected: bleUp }); // current link state, immediately
    return () => {
      listeners[event].delete(cb);
    };
  }

  const api = { on, sendFrame, connect, disconnect, join, isConnected, setUrl, getUrl };
  api.setBridgeUrl = setUrl; // alias probed by the sim controls panel
  api.setRelayUrl = setUrl; // alias kept for relay-era call sites
  return api;
}
