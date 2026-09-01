/**
 * A complete in-memory `Storage` for specs that exercise localStorage.
 *
 * Spec files share one jsdom global in this setup, and several of them replace
 * `globalThis.localStorage` with partial stubs. Any spec that depends on real
 * Storage semantics therefore has to install its own rather than trusting
 * whatever the previously-loaded file left behind.
 *
 * Returns a restore function; call it from `afterEach`.
 */
export function installMemoryLocalStorage(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>();

  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });

  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  };
}
