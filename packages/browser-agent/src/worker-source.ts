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
    if (pending.size >= 64) return Promise.reject(new Error('At most 64 concurrent browser operations'));
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
    rpc,
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
    complete(runId, value, failed, error) { done = {runId, value: value ?? null, ...(failed ? {error: String(error?.message ?? error) || 'Browser code threw an empty value'} : {})}; },
    begin() { done = null; logs.length = 0; bytes = 0; },
    drain() {
      const result = stringify({queue: queue.splice(0), logs: logs.splice(0), done, pending: pending.size, callbacks: __pw.drain()});
      if (result.length > 1048576) throw new Error('Execution output exceeded 1 MiB; summarize in code');
      return result;
    }
  });
})();
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
const scopeTimers = new Map();
let timerWindow=Date.now(),timerFirings=0;
const primitive = input => {
  if(typeof input!=='string'||input.length>1048576)return '{"error":"Data utility limit exceeded"}';
  try {
    const item=JSON.parse(input);let value;
    if(item.op==='timer-set'||item.op==='timer-clear'){
      if(!Number.isSafeInteger(item.id)||item.id<1)throw new Error();
      if(scopeTimers.has(item.id)){clearTimeout(scopeTimers.get(item.id));scopeTimers.delete(item.id);}
      if(item.op==='timer-set'){
        if(scopeTimers.size>=128||!Number.isFinite(item.ms)||item.ms<0||item.ms>60000)throw new Error();
        scopeTimers.set(item.id,setTimeout(()=>{
          scopeTimers.delete(item.id);
          if(Date.now()-timerWindow>1000){timerWindow=Date.now();timerFirings=0;}
          if(++timerFirings>2000){parentPort.postMessage({fatal:'Code timer rate exceeded'});return;}
          try{run('__timers.fire('+item.id+')');drain();}catch{parentPort.postMessage({fatal:'Code timer callback failed or exceeded CPU limits'});}
        },item.ms));
      }
      value=null;
    }else if(item.op==='url'){
      if(typeof item.href!=='string'||(item.base!==undefined&&item.base!==null&&typeof item.base!=='string'))throw new Error();
      const url=new URL(item.href,item.base??undefined);
      const fields='href protocol username password host hostname port pathname search hash origin'.split(' ');
      if(item.key!==undefined){if(!fields.includes(item.key)||item.key==='origin'||typeof item.value!=='string')throw new Error();url[item.key]=item.value;}
      value=Object.fromEntries(fields.map(key=>[key,url[key]]));
    }else if(item.op==='params'||item.op==='params-string'){
      const params=new URLSearchParams(item.value);
      if(item.method!==undefined){if(!['append','set','delete','sort'].includes(item.method)||!Array.isArray(item.args)||item.args.some(arg=>typeof arg!=='string'))throw new Error();params[item.method](...item.args);}
      value=item.op==='params-string'?params.toString():[...params.entries()];
    }else if(item.op==='bytes-from'||item.op==='bytes-string'){
      if(!['utf8','utf-8','hex','base64'].includes(item.encoding))throw new Error();
      if(item.op==='bytes-from'){if(typeof item.value!=='string')throw new Error();const bytes=Buffer.from(item.value,item.encoding);if(bytes.length>1048576)throw new Error();value=Array.from(bytes);}
      else{if(!Array.isArray(item.value)||item.value.length>1048576||item.value.some(byte=>!Number.isInteger(byte)||byte<0||byte>255))throw new Error();value=Buffer.from(item.value).toString(item.encoding);}
    }else throw new Error();
    const result=JSON.stringify({value});return result.length>4194304?'{"error":"Data utility limit exceeded"}':result;
  }catch{return '{"error":"Invalid URL or binary data"}';}
};
Object.setPrototypeOf(primitive,null);Object.freeze(primitive);
context.__elevenexData=primitive;
run(workerData.realmData);
run(workerData.bootstrap);
run(workerData.facade);
let active = false, currentRun = 0;
process.on('unhandledRejection', () => {
  parentPort.postMessage({fatal: 'An unawaited browser-code promise rejected. Await every operation.'});
  process.exit(1);
});
function drain() {
  const serialized = run('__bridge.drain()');
  if (Buffer.byteLength(serialized) > 1048576) throw new Error('Execution output exceeded 1 MiB; summarize in code');
  const message = JSON.parse(serialized);
  parentPort.postMessage(message);
  if (message.done?.runId === currentRun && !message.pending && !message.queue.length) active = false;
}
parentPort.on('message', message => {
  try {
    if (message.type === 'run') {
      if (active) throw new Error('Execution already running');
      active = true; currentRun = message.runId;
      run('__bridge.begin()');
      run('(async () => {\n' + message.code + '\n})().then(v => __bridge.complete(' + message.runId + ',v,false), e => __bridge.complete(' + message.runId + ',null,true,e))');
    } else if (message.type === 'init') {
      run('__pw.update(' + JSON.stringify(message.handles) + ')');
      return;
    } else if (message.type === 'callback') {
      run('__pw.update(' + JSON.stringify(message.handles) + '); __pw.invoke(' + message.id + ',' + message.functionId + ',' + JSON.stringify(message.args) + ')');
    } else if (message.type === 'reply') {
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
