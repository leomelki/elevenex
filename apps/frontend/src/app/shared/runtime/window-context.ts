import type { ElectronEnvironmentRef } from './electron-windows';

/**
 * Identity of the desktop window this renderer runs in.
 *
 * Every Elevenex window shares one Chromium profile, and therefore one
 * localStorage. Anything that is per-window rather than per-app — the active
 * environment, open tabs, panel layout — has to be namespaced by this id or two
 * windows would silently overwrite each other's state.
 *
 * In a browser (no Electron bridge) there is exactly one context, so the
 * constant fallback is correct: the namespace collapses back to what it was
 * before multi-window existed.
 *
 * Reads `window.__ELEVENEX_RUNTIME__` directly rather than through
 * `getRuntimeConfig()`: runtime-config depends on the onboarding state, which
 * depends on the window id, and going through it would close an import cycle.
 */
export const BROWSER_WINDOW_ID = 'w0';

interface InjectedWindowRuntime {
  windowId?: string;
  windowEnvironment?: ElectronEnvironmentRef | null;
}

function readInjectedRuntime(): InjectedWindowRuntime {
  if (typeof window === 'undefined') {
    return {};
  }

  return (window.__ELEVENEX_RUNTIME__ ?? {}) as InjectedWindowRuntime;
}

export function getWindowId(): string {
  return readInjectedRuntime().windowId || BROWSER_WINDOW_ID;
}

/**
 * The environment the main process opened this window on. Authoritative before
 * the window has written any state of its own, which is what makes a restored
 * SSH window come back on its server instead of flashing the local workspace.
 */
export function getInjectedWindowEnvironment(): ElectronEnvironmentRef | null {
  return readInjectedRuntime().windowEnvironment ?? null;
}
