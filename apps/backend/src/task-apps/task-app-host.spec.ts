import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { AppPacketReader } from './display-capture.js';
import { appDisplaySize } from './app-display-size.js';
import { hostInput } from './app-input.js';
import {
  appEnvironment,
  TaskAppHost,
  type AppLaunch,
} from './task-app-host.js';

const request: AppLaunch = {
  taskId: 21,
  requestId: 'test-1',
  name: 'Example',
  mode: 'stream',
  cwd: process.cwd(),
  executable: process.execPath,
  args: ['--version'],
};

it('assembles arbitrarily split media chunks without losing packet boundaries', () => {
  const output: string[] = [];
  const reader = new AppPacketReader((packet) =>
    output.push(packet.toString()),
  );
  reader.data(Buffer.from('abcd'));
  reader.metadata(Buffer.from('1\n5'));
  reader.metadata(Buffer.from('\n1\n'));
  reader.data(Buffer.from('efg'));
  expect(output).toEqual(['a', 'bcdef', 'g']);
  expect(() => reader.metadata(Buffer.from('8388608\n'))).toThrow();
});

it('limits input to the private display and supported physical keys', () => {
  expect(hostInput({ kind: 'key', code: 'ControlLeft', down: true }, appDisplaySize({}))).toEqual({
    kind: 'key',
    keycode: 37,
    down: true,
  });
  expect(() =>
    hostInput({ kind: 'key', code: 'constructor', down: true }, appDisplaySize({})),
  ).toThrow();
  expect(() => hostInput({ kind: 'down', x: 1280, y: 799 }, appDisplaySize({}))).toThrow();
});

it('builds an app environment independently of backend credentials', () => {
  process.env.TEST_APP_SECRET = 'sensitive';
  try {
    const env = appEnvironment('run', '/tmp/location');
    expect(env.ELEVENEX_TASK_APP_RUNTIME_DIR).toBe('/tmp/location');
    expect(env.TEST_APP_SECRET).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  } finally {
    delete process.env.TEST_APP_SECRET;
  }
});

it('reserves a starting run before launch and handles duplicate requests and early stop', async () => {
  const host = new TaskAppHost();
  // Native mode allows this race on every OS without starting a graphical server.
  const launch = { ...request, mode: 'native' as const };
  try {
    const [first, second] = await Promise.all([
      host.start(launch),
      host.start(launch),
    ]);
    expect(second.runId).toBe(first.runId);
    expect(host.count(launch.taskId)).toBe(1);
    expect(host.beginRuntimeHandoff()).toBe(1);
    expect(() => host.get(99, first.runId)).toThrow();
    await expect(host.start({ ...launch, name: 'Different' })).rejects.toThrow(
      'reused',
    );
    await host.stopAll(launch.taskId);
    expect(host.count(launch.taskId)).toBe(0);
    expect(host.beginRuntimeHandoff()).toBe(0);
    await expect(
      host.start({ ...launch, requestId: 'another' }),
    ).rejects.toThrow('runtime update');
    expect(host.get(launch.taskId, first.runId).status).toBe('exited');
  } finally {
    await host.onModuleDestroy();
  }
});

const nativeLinux =
  process.env.ELEVENEX_TEST_APP_DISPLAY === '1' && process.platform === 'linux'
    ? it
    : it.skip;
nativeLinux(
  'streams a real private X window, accepts pointer and keyboard input and drains the run',
  async () => {
    const host = new TaskAppHost();
    const program = String.raw`
import ctypes as c
x = c.CDLL('libX11.so.6')
x.XOpenDisplay.restype = c.c_void_p
d = c.c_void_p(x.XOpenDisplay(None))
assert d
root = x.XDefaultRootWindow(d)
w = x.XCreateSimpleWindow(d,root,0,0,600,400,0,0,0x3469B0)
x.XSelectInput(d,w,(1<<2) | (1<<0))
x.XMapWindow(d,w)
x.XFlush(d)
print('mapped', flush=True)
e = c.create_string_buffer(192)
while True:
    x.XNextEvent(d,e)
    attributes = c.create_string_buffer(256)
    x.XGetWindowAttributes(d,w,attributes)
    geometry = (c.c_int*4).from_buffer(attributes)
    print('event %d at %dx%d' % (c.c_int.from_buffer(e).value, geometry[2],geometry[3]), flush=True)
`;
    const run = await host.start({
      ...request,
      virtualDisplay: { width: 720, height: 1280 },
      executable: '/usr/bin/python3',
      args: ['-u', '-c', program],
    });
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (test()) return;
        const current = host.get(21, run.runId);
        if (current.status === 'failed')
          throw new Error(current.detail + '\n' + host.output(21, run.runId));
        await wait(50);
      }
      throw new Error('Timed out: ' + host.output(21, run.runId));
    };
    try {
      await until(
        () =>
          host.output(21, run.runId).includes('mapped') &&
          host.get(21, run.runId).status === 'running',
      );
      let key = false;
      const unwatch = host.watch(21, run.runId, {
        frame: (frame) => {
          if (frame.key && frame.width === 720 && frame.height === 1280 && frame.data.length > 100)
            key = true;
        },
        end: () => undefined,
      });
      try {
        await until(() => key);
        host.acquireInput(21, run.runId, 'viewer1');
        expect(() => host.acquireInput(21, run.runId, 'viewer2')).toThrow(
          'Another viewer',
        );
        await host.input(21, run.runId, 'viewer1', {
          kind: 'down',
          x: 360,
          y: 640,
          button: 0,
        });
        await host.input(21, run.runId, 'viewer1', {
          kind: 'key',
          code: 'KeyA',
          down: true,
        });
        await host.releaseInput(21, run.runId, 'viewer1');
        await until(
          () =>
            host.output(21, run.runId).includes('event 4') &&
            host.output(21, run.runId).includes('event 2'),
        );
        const managers = await Promise.all(
          ['openbox', 'fluxbox', 'xfwm4', 'twm'].map((name) =>
            access('/usr/bin/' + name).then(
              () => true,
              () => false,
            ),
          ),
        );
        if (!managers.some(Boolean))
          expect(host.output(21, run.runId)).toContain('at 720x1280');
      } finally {
        unwatch();
      }
      expect(host.get(21, run.runId).status).toBe('running');
    } finally {
      await host.onModuleDestroy();
    }
    expect(host.count(21)).toBe(0);
  },
  30000,
);

const nativeElectron =
  process.env.ELEVENEX_TEST_ELECTRON_APP === '1' &&
  ['linux', 'darwin', 'win32'].includes(process.platform)
    ? it
    : it.skip;
nativeElectron(
  'captures a sandboxed Electron app and types into the focused renderer',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elevenex-app-fixture-'));
    const app = join(directory, 'main.cjs');
    const host = new TaskAppHost();
    try {
      await writeFile(
        app,
        `
      const { app, BrowserWindow } = require('electron');
      const path = require('node:path');
      app.setPath('userData', path.join(process.env.ELEVENEX_TASK_APP_RUNTIME_DIR, 'profile'));
      let win;
      app.whenReady().then(async () => {
        win = new BrowserWindow({width: 560, height: 420, webPreferences:{sandbox:true, nodeIntegration:false, contextIsolation:true}});
        await win.loadURL('data:text/html,<input id="entry" autofocus style="width:100vw;height:100vh" />');
        win.show();
        win.focus();
        await win.webContents.executeJavaScript('document.querySelector("input").focus()');
        await win.webContents.executeJavaScript('document.querySelector("input").addEventListener("input", e=>console.log("value-"+e.target.value))');
        win.webContents.on('console-message', (...args) => { console.log(args[1]?.message ?? args[2]); });
        console.log('fixture-ready');
        win.webContents.on('before-input-event', (_, event) => {
          if (event.type === 'keyDown') console.log('typed-' + event.code);
        });
      });
    `,
      );
      const requireDesktop = createRequire(
        resolve(__dirname, '../../../desktop/package.json'),
      );
      const electron: unknown = requireDesktop('electron');
      if (typeof electron !== 'string')
        throw new Error('Installed Electron is unavailable');
      const state = await host.start({
        ...request,
        executable: electron,
        args: [app],
      });
      const until = async (test: () => boolean) => {
        for (let i = 0; i < 300; i++) {
          if (test()) return;
          const run = host.get(request.taskId, state.runId);
          if (run.status === 'failed' || run.status === 'exited')
            throw new Error(
              run.detail + '\n' + host.output(request.taskId, state.runId),
            );
          await wait(50);
        }
        throw new Error(
          'Electron fixture timeout: ' +
            host.output(request.taskId, state.runId),
        );
      };
      await until(
        () =>
          host.output(request.taskId, state.runId).includes('fixture-ready') &&
          host.get(request.taskId, state.runId).status === 'running',
      );
      let key = false;
      const close = host.watch(request.taskId, state.runId, {
        frame: (f) => {
          if (f.key) key = true;
        },
        end: () => undefined,
      });
      try {
        await until(() => key);
        host.acquireInput(request.taskId, state.runId, 'human');
        await host.input(request.taskId, state.runId, 'human', {
          kind: 'key',
          code: 'KeyA',
          down: true,
        });
        await host.input(request.taskId, state.runId, 'human', {
          kind: 'key',
          code: 'KeyA',
          down: false,
        });
        await host.input(request.taskId, state.runId, 'human', {
          kind: 'text',
          text: 'axX$zÅ中🙂',
        });
        await host.releaseInput(request.taskId, state.runId, 'human');
        await until(
          () =>
            host.output(request.taskId, state.runId).includes('typed-KeyA') &&
            host.output(request.taskId, state.runId).includes('axX$zÅ中🙂'),
        );
      } finally {
        close();
      }
    } finally {
      await host.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it('binds a request to one immutable specification, and requires explicit promotion', async () => {
  const host = new TaskAppHost();
  const args = ['--version'];
  const spec = { ...request, mode: 'native' as const, args };
  const authority = { sessionId: 9, checkoutToken: 'generation1' };
  try {
    const pending = host.propose(spec, authority);
    expect(pending.status).toBe('requested');
    expect(host.count(request.taskId)).toBe(0);
    expect((await host.start(spec)).status).toBe('requested');
    args[0] = '--help';
    expect(host.pending(request.taskId, pending.runId).launch.args).toEqual([
      '--version',
    ]);
    expect(() => host.propose(spec, authority)).toThrow('reused');
    expect(host.approve(request.taskId, pending.runId).runId).toBe(
      pending.runId,
    );
    expect(() => host.pending(request.taskId, pending.runId)).toThrow();
    expect(host.count(request.taskId)).toBe(1);
    const second = host.propose({ ...spec, requestId: 'later' }, authority);
    await host.stopAll(request.taskId);
    expect(host.get(request.taskId, second.runId).detail).toContain(
      'cancelled',
    );
  } finally {
    await host.onModuleDestroy();
  }
});

it('expires a pending launch without starting or retaining its checkout', async () => {
  const host = new TaskAppHost();
  jest.useFakeTimers();
  try {
    const run = host.propose(
      { ...request, mode: 'native' },
      { sessionId: 10, checkoutToken: 'generation' },
    );
    jest.advanceTimersByTime(600_001);
    expect(() => host.approve(run.taskId, run.runId)).toThrow('unavailable');
    expect(host.get(run.taskId, run.runId).detail).toContain('expired');
    expect(host.count(run.taskId)).toBe(0);
  } finally {
    jest.useRealTimers();
    await host.onModuleDestroy();
  }
});

it('shows the selected Android device and disposable data options before approval', async () => {
  const host = new TaskAppHost();
  try {
    const proposal = host.propose(
      {
        ...request,
        executable: 'emulator',
        args: [],
        android: { avd: 'Pixel_API_35' },
      },
      { sessionId: 9, checkoutToken: 'test' },
    );
    expect(proposal.pendingLaunch?.args).toEqual([
      '-avd',
      'Pixel_API_35',
      '-datadir',
      '<private run directory>/avd-data',
      '-read-only',
      '-no-snapshot',
      '-no-audio',
      '-camera-front',
      'none',
      '-camera-back',
      'none',
    ]);
  } finally {
    await host.onModuleDestroy();
  }
});

nativeLinux(
  'stops a descendant after its launcher exits and it creates a new session',
  async () => {
    const host = new TaskAppHost();
    const program = String.raw`
import os, signal, time
if os.fork():
    os._exit(0)
os.setsid()
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print('detached %d' % os.getpid(),flush=True)
time.sleep(120)
`;
    try {
      const launch = await host.start({
        ...request,
        executable: '/usr/bin/python3',
        args: ['-u', '-c', program],
      });
      let pid = 0;
      for (let i = 0; i < 200 && !pid; i++) {
        await wait(40);
        pid = Number(
          /detached (\d+)/.exec(
            host.output(launch.taskId, launch.runId),
          )?.[1] ?? 0,
        );
      }
      expect(pid).toBeGreaterThan(0);
      expect(host.count(launch.taskId)).toBe(1);
      await host.stopAll(launch.taskId);
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    } finally {
      await host.onModuleDestroy();
    }
  },
  20000,
);

it('finalizes an observed saved Action once and retains checkout ownership until the observer commits', async () => {
  const host = new TaskAppHost();
  let persist!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const observer = {
    output: jest.fn(),
    finished: jest.fn(() => {
      started();
      return new Promise<void>((resolve) => {
        persist = resolve;
      });
    }),
  };
  const spec = {
    ...request,
    mode: 'native' as const,
    args: ['-c', 'x'.repeat(3000)],
    savedAction: { id: 1, command: 'x'.repeat(3000) },
  };
  const ignored = { output: jest.fn(), finished: jest.fn(async () => {}) };
  try {
    const run = await host.start(spec, observer);
    expect((await host.start(spec, ignored)).runId).toBe(run.runId);
    const stop = host.stop(spec.taskId, run.runId);
    await waiting;
    expect(host.count(spec.taskId)).toBe(1);
    expect(host.count(spec.taskId, true)).toBe(0);
    persist();
    await stop;
    expect(observer.finished).toHaveBeenCalledTimes(1);
    expect(ignored.finished).not.toHaveBeenCalled();
    expect(host.count(spec.taskId)).toBe(0);
  } finally {
    persist?.();
    await host.onModuleDestroy();
  }
});

it('wakes status readers on transitions and detaches interrupted waits', async () => {
  const host = new TaskAppHost();
  const { runId } = host.propose(request, { sessionId: 2, checkoutToken: 'current' });
  const controller = new AbortController();
  const waiting = host.waitForChange(request.taskId, runId, 'requested', 30000, controller.signal);
  const abandoned = new AbortController();
  const cancelled = host.waitForChange(request.taskId, runId, 'requested', 30000, abandoned.signal);
  abandoned.abort(new Error('cancelled'));
  await expect(cancelled).rejects.toThrow('cancelled');
  await host.stop(request.taskId, runId);
  await expect(waiting).resolves.toMatchObject({ runId, status: 'exited' });
  await host.onModuleDestroy();
});
