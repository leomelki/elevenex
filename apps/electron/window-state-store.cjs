// Persistence for the multi-window layout: which windows were open, where they
// sat, and which backend environment each one was bound to.
//
// Everything that decides *where* a window goes is a pure function so it can be
// tested without Electron — display geometry changes between runs (a laptop
// undocked from an external monitor is the common case) and restoring a window
// onto coordinates that no longer exist would leave it invisible with no way to
// get it back.
//
// Writes are debounced and atomic (tmp + rename): they fire on every move,
// resize and environment switch, and a half-written windows.json would cost the
// user their whole layout.

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const { normalizeEnvironmentRef } = require('./environment-ref.cjs');

const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 1440, height: 960 });
const MIN_WINDOW_SIZE = Object.freeze({ width: 1024, height: 720 });
const CASCADE_STEP = 32;
const MAX_PERSISTED_WINDOWS = 12;
const SAVE_DEBOUNCE_MS = 400;

function toInt(value, fallback) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeBounds(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const width = toInt(value.width, NaN);
  const height = toInt(value.height, NaN);
  const x = toInt(value.x, NaN);
  const y = toInt(value.y, NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  return {
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    width: Math.max(width, MIN_WINDOW_SIZE.width),
    height: Math.max(height, MIN_WINDOW_SIZE.height),
  };
}

function sanitizeEntry(value, index) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  if (!id) {
    return null;
  }

  return {
    id,
    bounds: sanitizeBounds(value.bounds),
    maximized: value.maximized === true,
    fullScreen: value.fullScreen === true,
    env: normalizeEnvironmentRef(value.env),
    zOrder: toInt(value.zOrder, index),
  };
}

// Tolerates anything: a truncated file, a hand-edited file, a file written by a
// future version. A broken layout must never keep the app from starting.
function sanitizeState(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.windows) ? value.windows : [];
  const seen = new Set();
  const sanitized = [];
  for (const [index, entry] of entries.entries()) {
    const next = sanitizeEntry(entry, index);
    if (!next || seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    sanitized.push(next);
  }

  return sanitized.sort((left, right) => left.zOrder - right.zOrder);
}

function areaOfIntersection(bounds, area) {
  const left = Math.max(bounds.x, area.x);
  const top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  return (right - left) * (bottom - top);
}

function centerWithin(area, width, height) {
  const clampedWidth = Math.min(width, area.width);
  const clampedHeight = Math.min(height, area.height);
  return {
    x: Math.round(area.x + (area.width - clampedWidth) / 2),
    y: Math.round(area.y + (area.height - clampedHeight) / 2),
    width: clampedWidth,
    height: clampedHeight,
  };
}

// A window is "reachable" when enough of it — including the draggable top strip —
// overlaps a work area that the user can actually click. Purely off-screen
// windows, and windows whose title bar sits above the top of the display, are
// re-centered on the nearest display instead.
function clampBoundsToDisplays(bounds, displays) {
  const areas = (displays || [])
    .map((display) => display?.workArea ?? display?.bounds ?? null)
    .filter((area) => area && Number.isFinite(area.width) && Number.isFinite(area.height));

  if (areas.length === 0) {
    return bounds ? { ...bounds } : null;
  }

  const primary = areas[0];
  const width = Math.max(toInt(bounds?.width, DEFAULT_WINDOW_BOUNDS.width), MIN_WINDOW_SIZE.width);
  const height = Math.max(toInt(bounds?.height, DEFAULT_WINDOW_BOUNDS.height), MIN_WINDOW_SIZE.height);

  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) {
    return centerWithin(primary, width, height);
  }

  const candidate = { x: toInt(bounds.x, 0), y: toInt(bounds.y, 0), width, height };
  const minVisible = Math.min(240, width) * Math.min(48, height);

  let best = null;
  for (const area of areas) {
    const overlap = areaOfIntersection(candidate, area);
    if (overlap > (best?.overlap ?? 0)) {
      best = { area, overlap };
    }
  }

  const titleBarOnScreen = best
    && candidate.y >= best.area.y
    && candidate.y < best.area.y + best.area.height;

  if (best && best.overlap >= minVisible && titleBarOnScreen) {
    return candidate;
  }

  // Nothing usable: fall back to the display nearest the remembered position so
  // a window that lived on a right-hand monitor comes back on that side.
  const candidateCenterX = candidate.x + candidate.width / 2;
  const candidateCenterY = candidate.y + candidate.height / 2;
  let nearest = primary;
  let nearestDistance = Infinity;
  for (const area of areas) {
    const dx = area.x + area.width / 2 - candidateCenterX;
    const dy = area.y + area.height / 2 - candidateCenterY;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = area;
    }
  }

  return centerWithin(nearest, width, height);
}

// New windows should not land exactly on top of an existing one — the user
// would think nothing happened. Step down-right until the origin is free,
// wrapping back to the top-left when the cascade would run off the work area.
function cascadeBounds(existingBounds, base, workArea) {
  const width = Math.max(toInt(base?.width, DEFAULT_WINDOW_BOUNDS.width), MIN_WINDOW_SIZE.width);
  const height = Math.max(toInt(base?.height, DEFAULT_WINDOW_BOUNDS.height), MIN_WINDOW_SIZE.height);
  const origin = {
    x: toInt(base?.x, workArea ? Math.round(workArea.x + (workArea.width - width) / 2) : 0),
    y: toInt(base?.y, workArea ? Math.round(workArea.y + (workArea.height - height) / 2) : 0),
  };

  const taken = new Set(
    (existingBounds || [])
      .filter((entry) => entry && Number.isFinite(entry.x) && Number.isFinite(entry.y))
      .map((entry) => `${Math.round(entry.x)}:${Math.round(entry.y)}`),
  );

  let x = origin.x;
  let y = origin.y;
  for (let step = 0; step <= taken.size; step += 1) {
    if (!taken.has(`${x}:${y}`)) {
      break;
    }
    x += CASCADE_STEP;
    y += CASCADE_STEP;
    if (workArea && (x + width > workArea.x + workArea.width || y + height > workArea.y + workArea.height)) {
      x = workArea.x + CASCADE_STEP;
      y = workArea.y + CASCADE_STEP;
    }
  }

  return { x, y, width, height };
}

// Keep the layout file bounded. Highest zOrder wins: the store records focus
// order, so the windows the user touched most recently survive.
function pruneOrphans(entries, max = MAX_PERSISTED_WINDOWS) {
  const sanitized = sanitizeState(entries);
  if (sanitized.length <= max) {
    return sanitized;
  }

  return [...sanitized]
    .sort((left, right) => right.zOrder - left.zOrder)
    .slice(0, max)
    .sort((left, right) => left.zOrder - right.zOrder);
}

function createWindowStateStore(options = {}) {
  const filePath = options.filePath;
  const asyncFs = options.fs || fsPromises;
  const syncFs = options.syncFs || fs;
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : SAVE_DEBOUNCE_MS;
  const maxWindows = Number.isFinite(options.maxWindows) ? options.maxWindows : MAX_PERSISTED_WINDOWS;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  let pendingEntries = null;
  let timer = null;
  let writeChain = Promise.resolve();

  async function load() {
    try {
      const raw = await asyncFs.readFile(filePath, 'utf8');
      return pruneOrphans(JSON.parse(raw), maxWindows);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        onError(error);
      }
      return [];
    }
  }

  function serialize(entries) {
    return `${JSON.stringify({ version: 1, windows: entries }, null, 2)}\n`;
  }

  function tmpPathFor() {
    return `${filePath}.${process.pid}.tmp`;
  }

  async function writeNow(entries) {
    const tmpPath = tmpPathFor();
    try {
      await asyncFs.mkdir(path.dirname(filePath), { recursive: true });
      await asyncFs.writeFile(tmpPath, serialize(entries), 'utf8');
      await asyncFs.rename(tmpPath, filePath);
    } catch (error) {
      onError(error);
      await asyncFs.rm?.(tmpPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Blocking write, used only on shutdown.
   *
   * Quitting is the moment the layout matters most, and an awaited async write
   * is not guaranteed to land before the process exits (there is a hard
   * force-exit a few seconds later). This runs once, on a path that is already
   * tearing everything down, so blocking here costs nothing.
   */
  function saveSync(entries) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingEntries = null;

    const tmpPath = tmpPathFor();
    try {
      syncFs.mkdirSync(path.dirname(filePath), { recursive: true });
      syncFs.writeFileSync(tmpPath, serialize(pruneOrphans(entries, maxWindows)), 'utf8');
      syncFs.renameSync(tmpPath, filePath);
    } catch (error) {
      onError(error);
      try {
        syncFs.rmSync(tmpPath, { force: true });
      } catch {
        // Best effort.
      }
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const entries = pendingEntries;
    pendingEntries = null;
    if (!entries) {
      return writeChain;
    }
    writeChain = writeChain.then(() => writeNow(entries));
    return writeChain;
  }

  function save(entries) {
    pendingEntries = pruneOrphans(entries, maxWindows);
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
    timer.unref?.();
  }

  return { flush, load, save, saveSync };
}

module.exports = {
  CASCADE_STEP,
  DEFAULT_WINDOW_BOUNDS,
  MAX_PERSISTED_WINDOWS,
  MIN_WINDOW_SIZE,
  cascadeBounds,
  clampBoundsToDisplays,
  createWindowStateStore,
  pruneOrphans,
  sanitizeState,
};
