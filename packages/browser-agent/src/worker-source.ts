// No host functions, objects, promises or errors cross the VM boundary. Both
// directions carry JSON strings only. The worker also bounds CPU and memory;
// the privileged broker independently validates every operation and target.
export const BOOTSTRAP = String.raw`
const state = Object.create(null);
const __bridge = (() => {
  const pending = new Map(), queue = [], logs = [];
  let sequence = 0, done = null, bytes = 0;
  const stringify = JSON.stringify;
  function rpc(method, args = []) {
    if (pending.size >= 16) return Promise.reject(new Error('At most 16 concurrent browser operations'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      queue.push({id, method, args});
    });
  }
  function tab(ref) {
    return Object.freeze({
      id: ref.id,
      goto: url => rpc('goto', [ref.handle, url]),
      evaluate: (fn, arg) => rpc('evaluate', [ref.handle, typeof fn === 'function' ? fn.toString() : fn, arg ?? null, typeof fn === 'function']),
      snapshot: (options = {}) => rpc('snapshot', [ref.handle, options]),
      click: (target, y) => rpc('click', [ref.handle, target, y ?? null]),
      fill: (target, text) => rpc('fill', [ref.handle, target, text]),
      type: text => rpc('type', [ref.handle, text]),
      press: key => rpc('press', [ref.handle, key]),
      scroll: (deltaX, deltaY, x = 0, y = 0) => rpc('scroll', [ref.handle, deltaX, deltaY, x, y]),
      screenshot: (options = {}) => rpc('screenshot', [ref.handle, options]),
      cdp: (method, params = {}) => rpc('cdp', [ref.handle, method, params]),
      events: (options = {}) => rpc('events', [ref.handle, options]),
      close: () => rpc('close', [ref.handle]),
      waitFor: async (fn, arg, options = {}) => {
        const end = Date.now() + Math.min(options.timeoutMs ?? 5000, 60000);
        do {
          const value = await rpc('evaluate', [ref.handle, fn.toString(), arg ?? null, true]);
          if (value) return value;
          await rpc('wait', [50]);
        } while (Date.now() < end);
        throw new Error('waitFor timed out; inspect the current page');
      }
    });
  }
  function log(...values) {
    const text = values.map(v => typeof v === 'string' ? v : stringify(v) ?? String(v)).join(' ');
    if (bytes + text.length > 32000 || logs.length >= 100) throw new Error('Console output limit reached; filter or summarize in code');
    bytes += text.length; logs.push(text);
  }
  return Object.freeze({
    browser: Object.freeze({tabs: Object.freeze({
      list: () => rpc('list'),
      new: async url => tab(await rpc('new', [url])),
      get: async id => tab(await rpc('get', [id]))
    }), wait: ms => rpc('wait', [ms])}),
    console: Object.freeze({log, info: log, warn: log, error: log}),
    reply(id, value, error) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error !== null) entry.reject(new Error(error)); else entry.resolve(value);
    },
    complete(value, error) { done = {value: value ?? null, ...(arguments.length > 1 ? {error: String(error?.message ?? error) || 'Browser code threw an empty value'} : {})}; },
    begin() { done = null; logs.length = 0; bytes = 0; },
    drain() {
      const result = stringify({queue: queue.splice(0), logs: logs.splice(0), done, pending: pending.size});
      if (result.length > 1048576) throw new Error('Execution output exceeded 1 MiB; summarize in code');
      return result;
    }
  });
})();
const browser = __bridge.browser;
const console = __bridge.console;
`;

export const WORKER_SOURCE = String.raw`
'use strict';
const {parentPort, workerData} = require('node:worker_threads');
const vm = require('node:vm');
const context = vm.createContext(Object.create(null), {
  codeGeneration: {strings: false, wasm: false}, microtaskMode: 'afterEvaluate'
});
const run = code => vm.runInContext(code, context, {timeout: 250});
run(workerData.bootstrap);
let active = false;
process.on('unhandledRejection', () => {
  parentPort.postMessage({fatal: 'An unawaited browser-code promise rejected. Await every operation.'});
  process.exit(1);
});
function drain() {
  const serialized = run('__bridge.drain()');
  if (Buffer.byteLength(serialized) > 1048576) throw new Error('Execution output exceeded 1 MiB; summarize in code');
  const message = JSON.parse(serialized);
  parentPort.postMessage(message);
  if (message.done && !message.pending && !message.queue.length) active = false;
}
parentPort.on('message', message => {
  try {
    if (message.type === 'run') {
      if (active) throw new Error('Execution already running');
      active = true;
      run('__bridge.begin()');
      run('(async () => {\n' + message.code + '\n})().then(v => __bridge.complete(v), e => __bridge.complete(null, e))');
    } else if (message.type === 'reply' && active) {
      run('__bridge.reply(' + message.id + ',' + JSON.stringify(message.value ?? null) + ',' + JSON.stringify(message.error ?? null) + ')');
    }
    drain();
  } catch {
    // VM-thrown values may contain getters or proxies. Never inspect them in
    // the host realm; ordinary script errors are formatted inside the VM.
    parentPort.postMessage({fatal: 'Browser code exceeded CPU/output limits or produced a non-serializable result. Sandbox reset.'});
  }
});
`;
