// Registry of open app windows.
//
// `main.cjs` used to hold a single `mainWindow`, which every push-to-renderer
// helper and every IPC handler reached for directly. With several windows open
// on different backends, "the window" is no longer a meaningful concept: an SSH
// phase update belongs to the windows sitting on *that* server, a browser-view
// state change belongs to the window that owns the view, and an update
// notification belongs to everyone.
//
// This module owns the id ↔ BrowserWindow ↔ environment mapping and the routing
// helpers built on it. It deliberately does not create windows — construction
// needs the frontend target, the resolved backend origin and the platform chrome
// options, all of which live in main.cjs.

const { environmentRefsEqual, normalizeEnvironmentRef } = require('./environment-ref.cjs');

function createWindowRegistry() {
  // Insertion-ordered: the Window menu and the persisted layout both read in
  // creation order so window positions stay stable across restarts.
  const entries = new Map();
  let sequence = 0;
  let focusCounter = 0;

  function nextWindowId() {
    sequence += 1;
    // Time-prefixed so ids stay unique across restarts (the persisted layout
    // reuses them) while remaining readable in logs.
    return `w-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function isAlive(entry) {
    return Boolean(entry?.win && !entry.win.isDestroyed());
  }

  function register(win, { id, env, backendOrigin }) {
    const entry = {
      id,
      win,
      env: normalizeEnvironmentRef(env),
      // The origin this window's renderer actually talks to. Distinct from the
      // environment ref: the ref says *which* backend, this says where it is
      // reachable right now (an SSH tunnel's local port changes per session).
      backendOrigin: backendOrigin || '',
      focusOrder: (focusCounter += 1),
    };
    entries.set(id, entry);
    return entry;
  }

  function unregister(id) {
    entries.delete(id);
  }

  function get(id) {
    const entry = entries.get(id);
    return isAlive(entry) ? entry : null;
  }

  function idOf(win) {
    if (!win) {
      return null;
    }
    for (const entry of entries.values()) {
      if (entry.win === win) {
        return entry.id;
      }
    }
    return null;
  }

  function fromWebContents(webContents) {
    if (!webContents) {
      return null;
    }
    for (const entry of entries.values()) {
      if (isAlive(entry) && entry.win.webContents === webContents) {
        return entry;
      }
    }
    return null;
  }

  function all() {
    return [...entries.values()].filter(isAlive);
  }

  function count() {
    return all().length;
  }

  function envOf(id) {
    return get(id)?.env ?? null;
  }

  function setEnv(id, env) {
    const entry = entries.get(id);
    if (!entry) {
      return null;
    }
    entry.env = normalizeEnvironmentRef(env);
    return entry.env;
  }

  function backendOriginOf(id) {
    return entries.get(id)?.backendOrigin || '';
  }

  function setBackendOrigin(id, backendOrigin) {
    const entry = entries.get(id);
    if (entry && typeof backendOrigin === 'string' && backendOrigin) {
      entry.backendOrigin = backendOrigin.replace(/\/+$/, '');
    }
  }

  function markFocused(id) {
    const entry = entries.get(id);
    if (entry) {
      entry.focusOrder = (focusCounter += 1);
    }
  }

  function focused() {
    const alive = all();
    if (alive.length === 0) {
      return null;
    }
    return alive.find((entry) => entry.win.isFocused())
      // Nothing has OS focus (a menu click while another app is frontmost):
      // fall back to the window the user touched most recently.
      ?? alive.reduce((best, entry) => (entry.focusOrder > best.focusOrder ? entry : best));
  }

  function focusWindow(id) {
    const entry = get(id);
    if (!entry) {
      return false;
    }
    if (entry.win.isMinimized()) {
      entry.win.restore();
    }
    entry.win.show();
    entry.win.focus();
    markFocused(id);
    return true;
  }

  function send(entry, channel, payload) {
    if (!isAlive(entry)) {
      return;
    }
    entry.win.webContents.send(channel, payload);
  }

  function sendTo(id, channel, payload) {
    send(entries.get(id), channel, payload);
  }

  function broadcast(channel, payload) {
    for (const entry of all()) {
      send(entry, channel, payload);
    }
  }

  // Route an environment-scoped event to every window bound to it. `extraIds`
  // covers windows that are still *connecting* to that environment and so do
  // not hold it yet — without them the window that triggered a remote install
  // would never see its own progress.
  function sendToEnv(env, channel, payload, extraIds = []) {
    const seen = new Set();
    for (const entry of all()) {
      if (environmentRefsEqual(entry.env, env)) {
        seen.add(entry.id);
        send(entry, channel, payload);
      }
    }
    for (const id of extraIds) {
      if (!seen.has(id)) {
        seen.add(id);
        sendTo(id, channel, payload);
      }
    }
  }

  // Serializable view for the renderer: which windows exist, what each is bound
  // to, and which one is in front. Drives the "open elsewhere" chips and the
  // guard that stops a server being deleted while another window uses it.
  function list() {
    const focusedEntry = focused();
    return all().map((entry) => ({
      windowId: entry.id,
      envRef: entry.env,
      label: entry.env.label,
      focused: entry.id === focusedEntry?.id,
    }));
  }

  function toPersistedState() {
    return all().map((entry) => {
      const { win } = entry;
      const maximized = win.isMaximized();
      const fullScreen = win.isFullScreen();
      return {
        id: entry.id,
        // getBounds() reports the maximized/fullscreen frame, which would
        // restore as a window that cannot be un-maximized back to a sane size.
        bounds: maximized || fullScreen ? win.getNormalBounds() : win.getBounds(),
        maximized,
        fullScreen,
        env: entry.env,
        zOrder: entry.focusOrder,
      };
    });
  }

  return {
    all,
    backendOriginOf,
    broadcast,
    count,
    envOf,
    focusWindow,
    focused,
    fromWebContents,
    get,
    idOf,
    list,
    markFocused,
    nextWindowId,
    register,
    sendTo,
    sendToEnv,
    setBackendOrigin,
    setEnv,
    toPersistedState,
    unregister,
  };
}

module.exports = { createWindowRegistry };
