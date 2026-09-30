// Tiny event emitter for cross-panel messages inside the simulator.
// UI panels never talk to each other directly; they publish/subscribe here.
// Intentionally dependency-free and framework-free.
export function createBus() {
  const handlers = new Map();

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    // return an unsubscribe handle
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = handlers.get(event);
    if (set) set.delete(fn);
  }

  function once(event, fn) {
    const unsub = on(event, (...args) => {
      unsub();
      fn(...args);
    });
    return unsub;
  }

  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    // copy the set so a handler that unsubscribes mid-emit cannot break iteration
    for (const fn of [...set]) {
      try {
        fn(payload, event);
      } catch (err) {
        console.error(`[bus] handler for "${event}" threw:`, err);
      }
    }
  }

  return { on, off, once, emit };
}
