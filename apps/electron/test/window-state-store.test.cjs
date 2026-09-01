const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_WINDOW_BOUNDS,
  MIN_WINDOW_SIZE,
  cascadeBounds,
  clampBoundsToDisplays,
  createWindowStateStore,
  pruneOrphans,
  sanitizeState,
} = require('../window-state-store.cjs');

const LAPTOP = { workArea: { x: 0, y: 0, width: 1680, height: 1050 } };
const EXTERNAL = { workArea: { x: 1680, y: -200, width: 2560, height: 1440 } };

function entry(overrides = {}) {
  return {
    id: 'w-1',
    bounds: { x: 100, y: 100, width: 1440, height: 960 },
    maximized: false,
    fullScreen: false,
    env: { mode: 'local' },
    zOrder: 0,
    ...overrides,
  };
}

describe('sanitizeState', () => {
  it('accepts both the bare array and the versioned envelope', () => {
    assert.equal(sanitizeState([entry()]).length, 1);
    assert.equal(sanitizeState({ version: 1, windows: [entry()] }).length, 1);
  });

  it('drops entries without a usable id and de-duplicates', () => {
    const state = sanitizeState([
      entry({ id: '' }),
      entry({ id: '   ' }),
      entry({ id: 'w-1' }),
      entry({ id: 'w-1' }),
      null,
      'nope',
    ]);
    assert.deepEqual(state.map((item) => item.id), ['w-1']);
  });

  it('sorts by zOrder and normalizes the environment ref', () => {
    const state = sanitizeState([
      entry({ id: 'b', zOrder: 5, env: { mode: 'ssh', serverId: 9, label: 'Prod' } }),
      entry({ id: 'a', zOrder: 1, env: { mode: 'bogus' } }),
    ]);
    assert.deepEqual(state.map((item) => item.id), ['a', 'b']);
    assert.equal(state[0].env.mode, 'local');
    assert.equal(state[1].env.serverId, 9);
  });

  it('enforces the minimum window size and tolerates partial bounds', () => {
    const [small] = sanitizeState([entry({ bounds: { x: 0, y: 0, width: 10, height: 10 } })]);
    assert.equal(small.bounds.width, MIN_WINDOW_SIZE.width);
    assert.equal(small.bounds.height, MIN_WINDOW_SIZE.height);

    const [noSize] = sanitizeState([entry({ bounds: { x: 0, y: 0 } })]);
    assert.equal(noSize.bounds, null);
  });
});

describe('clampBoundsToDisplays', () => {
  it('keeps a window that is already comfortably on screen', () => {
    const bounds = { x: 120, y: 80, width: 1440, height: 960 };
    assert.deepEqual(clampBoundsToDisplays(bounds, [LAPTOP]), bounds);
  });

  it('re-centers a window whose display was unplugged', () => {
    // Remembered on the external monitor; only the laptop is connected now.
    const clamped = clampBoundsToDisplays({ x: 2400, y: 300, width: 1440, height: 960 }, [LAPTOP]);
    assert.equal(clamped.x, Math.round((1680 - 1440) / 2));
    assert.equal(clamped.y, Math.round((1050 - 960) / 2));
  });

  it('keeps the window on the display it used to live on when both are present', () => {
    const clamped = clampBoundsToDisplays({ x: 2400, y: 300, width: 1440, height: 960 }, [LAPTOP, EXTERNAL]);
    assert.equal(clamped.x, 2400, 'still overlaps the external monitor, so it is left alone');
  });

  it('rescues a window whose title bar sits above the top of the display', () => {
    const clamped = clampBoundsToDisplays({ x: 100, y: -900, width: 1440, height: 960 }, [LAPTOP]);
    assert.ok(clamped.y >= 0, 'an unreachable title bar leaves the window undraggable');
  });

  it('centers on the primary display when no position was recorded', () => {
    const clamped = clampBoundsToDisplays({ width: 1440, height: 960 }, [LAPTOP]);
    assert.equal(clamped.x, 120);
    assert.equal(clamped.y, 45);
  });

  it('shrinks a window that no longer fits the available work area', () => {
    const tiny = { workArea: { x: 0, y: 0, width: 1200, height: 800 } };
    const clamped = clampBoundsToDisplays({ x: 9000, y: 9000, width: 1440, height: 960 }, [tiny]);
    assert.equal(clamped.width, 1200);
    assert.equal(clamped.height, 800);
  });

  it('passes bounds through untouched when the display list is unavailable', () => {
    const bounds = { x: 5, y: 5, width: 1440, height: 960 };
    assert.deepEqual(clampBoundsToDisplays(bounds, []), bounds);
    assert.deepEqual(clampBoundsToDisplays(bounds, null), bounds);
  });
});

describe('cascadeBounds', () => {
  it('leaves a free origin alone', () => {
    const next = cascadeBounds([], { x: 100, y: 100, ...DEFAULT_WINDOW_BOUNDS }, LAPTOP.workArea);
    assert.equal(next.x, 100);
    assert.equal(next.y, 100);
  });

  it('steps off an occupied origin so the new window is visibly new', () => {
    const base = { x: 100, y: 100, width: 1440, height: 960 };
    const next = cascadeBounds([{ x: 100, y: 100 }], base, EXTERNAL.workArea);
    assert.notDeepEqual([next.x, next.y], [100, 100]);
  });

  it('wraps back into the work area instead of cascading off screen', () => {
    const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
    const taken = [{ x: 100, y: 100 }, { x: 132, y: 132 }];
    const next = cascadeBounds(taken, { x: 100, y: 100, width: 1500, height: 900 }, workArea);
    assert.ok(next.x + next.width <= workArea.width + 32);
    assert.ok(next.y >= 0);
  });

  it('centers when the caller has no base position', () => {
    const next = cascadeBounds([], { width: 1440, height: 960 }, LAPTOP.workArea);
    assert.equal(next.x, 120);
    assert.equal(next.y, 45);
  });
});

describe('pruneOrphans', () => {
  it('keeps the most recently focused windows when over the limit', () => {
    const entries = [0, 1, 2, 3, 4].map((index) => entry({ id: `w-${index}`, zOrder: index }));
    const pruned = pruneOrphans(entries, 3);
    assert.deepEqual(pruned.map((item) => item.id), ['w-2', 'w-3', 'w-4']);
  });

  it('is a no-op below the limit', () => {
    assert.equal(pruneOrphans([entry()], 12).length, 1);
  });
});

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    files,
    async readFile(filePath) {
      if (!files.has(filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    async writeFile(filePath, contents) {
      calls.push(['writeFile', filePath]);
      files.set(filePath, contents);
    },
    async rename(from, to) {
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async mkdir() {},
    async rm(filePath) {
      files.delete(filePath);
    },
  };
}

describe('createWindowStateStore', () => {
  const filePath = '/userData/windows.json';

  it('returns an empty layout when the file has never been written', async () => {
    const store = createWindowStateStore({ filePath, fs: memoryFs() });
    assert.deepEqual(await store.load(), []);
  });

  it('returns an empty layout instead of crashing on a corrupt file', async () => {
    const errors = [];
    const store = createWindowStateStore({
      filePath,
      fs: memoryFs({ [filePath]: '{ not json' }),
      onError: (error) => errors.push(error),
    });
    assert.deepEqual(await store.load(), []);
    // Losing a layout is recoverable but not normal — it should leave a trace.
    assert.equal(errors.length, 1);
  });

  it('does not report a missing file as an error', async () => {
    const errors = [];
    const store = createWindowStateStore({
      filePath,
      fs: memoryFs(),
      onError: (error) => errors.push(error),
    });
    await store.load();
    assert.deepEqual(errors, [], 'first launch has no layout yet');
  });

  it('round-trips a saved layout', async () => {
    const fs = memoryFs();
    const store = createWindowStateStore({ filePath, fs, debounceMs: 0 });
    store.save([entry({ id: 'w-a', env: { mode: 'ssh', serverId: 4, label: 'Prod' } })]);
    await store.flush();

    const reloaded = await store.load();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].id, 'w-a');
    assert.equal(reloaded[0].env.serverId, 4);
    assert.equal(reloaded[0].env.label, 'Prod');
  });

  it('writes atomically through a temp file', async () => {
    const fs = memoryFs();
    const store = createWindowStateStore({ filePath, fs, debounceMs: 0 });
    store.save([entry()]);
    await store.flush();

    const [write, rename] = fs.calls;
    assert.equal(write[0], 'writeFile');
    assert.notEqual(write[1], filePath, 'must not write the live file in place');
    assert.deepEqual([rename[0], rename[2]], ['rename', filePath]);
  });

  it('coalesces bursts of saves into a single write', async () => {
    const fs = memoryFs();
    const store = createWindowStateStore({ filePath, fs, debounceMs: 5 });
    // A drag emits move events continuously; each must not hit the disk.
    for (let index = 0; index < 20; index += 1) {
      store.save([entry({ bounds: { x: index, y: index, width: 1440, height: 960 } })]);
    }
    await store.flush();

    assert.equal(fs.calls.filter(([kind]) => kind === 'writeFile').length, 1);
    const saved = JSON.parse(fs.files.get(filePath));
    assert.equal(saved.windows[0].bounds.x, 19, 'the last state wins');
  });

  it('flush without a pending save is harmless', async () => {
    const fs = memoryFs();
    const store = createWindowStateStore({ filePath, fs, debounceMs: 0 });
    await store.flush();
    assert.equal(fs.calls.length, 0);
  });

  it('applies the window cap when persisting', async () => {
    const fs = memoryFs();
    const store = createWindowStateStore({ filePath, fs, debounceMs: 0, maxWindows: 2 });
    store.save([0, 1, 2, 3].map((index) => entry({ id: `w-${index}`, zOrder: index })));
    await store.flush();

    const saved = JSON.parse(fs.files.get(filePath));
    assert.deepEqual(saved.windows.map((item) => item.id), ['w-2', 'w-3']);
  });

  it('writes synchronously on shutdown, when an async write may not land', () => {
    const calls = [];
    const files = new Map();
    const syncFs = {
      mkdirSync: () => {},
      writeFileSync: (target, contents) => {
        calls.push(['writeFileSync', target]);
        files.set(target, contents);
      },
      renameSync: (from, to) => {
        calls.push(['renameSync', from, to]);
        files.set(to, files.get(from));
        files.delete(from);
      },
      rmSync: () => {},
    };
    const store = createWindowStateStore({ filePath, fs: memoryFs(), syncFs, debounceMs: 1000 });

    // A pending debounced write must not survive and clobber the final state.
    store.save([entry({ id: 'stale' })]);
    store.saveSync([entry({ id: 'final' })]);

    assert.deepEqual(calls.map(([kind]) => kind), ['writeFileSync', 'renameSync']);
    assert.deepEqual(JSON.parse(files.get(filePath)).windows.map((item) => item.id), ['final']);
  });

  it('reports a failed shutdown write instead of throwing', () => {
    const errors = [];
    const syncFs = {
      mkdirSync: () => {},
      writeFileSync: () => { throw new Error('EACCES'); },
      renameSync: () => {},
      rmSync: () => {},
    };
    const store = createWindowStateStore({
      filePath,
      fs: memoryFs(),
      syncFs,
      onError: (error) => errors.push(error),
    });

    store.saveSync([entry()]);
    assert.equal(errors.length, 1);
  });

  it('reports real filesystem failures', async () => {
    const errors = [];
    const fs = memoryFs();
    fs.writeFile = async () => { throw new Error('EACCES'); };
    const store = createWindowStateStore({
      filePath,
      fs,
      debounceMs: 0,
      onError: (error) => errors.push(error),
    });
    store.save([entry()]);
    await store.flush();
    assert.equal(errors.length, 1);
  });
});
