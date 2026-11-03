const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createHash, webcrypto } = require('node:crypto');
const vm = require('node:vm');
const digest = text => createHash('sha256').update(text).digest('hex');

// Exercise the web extension through the actual VS Code provider/command APIs.
// Only the upstream host, durable memento and unreliable transport are controlled.
async function mount(persisted, disk, options = {}) {
  let provider, document, writes = 0;
  const commands = new Map(), choices = [], comparisons = [], disposables = [], opened = [], themes = [];
  class Uri {
    constructor(value) { Object.assign(this, { scheme: 'elevenex-task', authority: 'task', path: '/', query: '', fragment: '' }, value); }
    with(value) { return new Uri({ ...this, ...value }); }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
    static from(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return base.with({ path: '/' + parts.join('/') }); }
  }
  class FileError extends Error {
    constructor(message, code) { super(message); this.code = code; }
    static Unavailable(message) { return new FileError(message, 'Unavailable'); }
    static NoPermissions(message) { return new FileError(message, 'NoPermissions'); }
    static FileNotFound() { return new FileError('missing', 'FileNotFound'); }
  }
  class Disposable { constructor(dispose) { this.dispose = dispose; } }
  class Emitter {
    constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); }; }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  class Range { constructor(...args) { this.args = args; } }
  const root = new Uri(), subscriptions = [];
  const documents = [];
  const vscode = {
    __esModule: true, Uri, Disposable, EventEmitter: Emitter, FileSystemError: FileError, Range,
    ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Left: 1 }, FileType: { File: 1 }, FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    window: { tabGroups: {activeTabGroup:{tabs:[]},all:[],onDidChangeTabs:()=>new Disposable(()=>{})}, onDidChangeActiveTextEditor:()=>new Disposable(()=>{}), createStatusBarItem: () => ({ show() {}, dispose() {} }), showWarningMessage: async () => choices.shift(), showTextDocument: async (uri, options) => { opened.push({ uri, options }); }, activeTextEditor: null },
    workspace: { getConfiguration: () => ({ update: async (key, value) => { themes.push({ key, value }); } }), workspaceFolders: [{ uri: root }], textDocuments: documents, fs: { stat: uri => provider.stat(uri) }, registerFileSystemProvider: (_scheme, value) => { provider = value; return new Disposable(() => {}); }, registerTextDocumentContentProvider: () => new Disposable(() => {}), registerFileSearchProvider: () => new Disposable(() => {}), registerTextSearchProvider: () => new Disposable(() => {}), onDidOpenTextDocument: () => new Disposable(() => {}), onDidChangeTextDocument: () => new Disposable(() => {}) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return new Disposable(() => {}); }, executeCommand: async (...args) => { comparisons.push(args); } },
  };
  const code = await readFile(require.resolve('../dist/code/web/extension.js'), 'utf8');
  const module = { exports: {} };
  const generation = disk.generation ?? 'a'.repeat(64);
  const json = value => globalThis.Response.json({ generation, transportRevision: options.transportRevision ?? 0, ...(options.dark === undefined ? {} : { dark: options.dark }), ...value });
  const fetch = async (url, request) => {
    const operation = new URL(url).pathname.split('/').at(-1), body = JSON.parse(request.body);
    if (operation === 'presentation') return json({accepted:true});
    if (operation === 'ready') return json({ accepted: true });
    if (operation === 'changes') return json({ sequence: 0, reset: false, paths: [], paused: options.pausedChanges ?? true });
    if (operation === 'stat') return json({ type: 1, size: disk.text.length, ctime: 1, mtime: 1 });
    if (operation === 'read') {
      if (options.unreachable) return new globalThis.Response(null, { status: 503 });
      return json({ content: Buffer.from(disk.text).toString('base64'), revision: digest(disk.text) });
    }
    if (operation === 'write') {
      writes++;
      if (options.dropWrite) return new globalThis.Response(null, { status: 503 });
      if (body.revision !== digest(disk.text)) return globalThis.Response.json({ error: 'file-conflict' }, { status: 409 });
      disk.text = Buffer.from(body.content, 'base64').toString();
      return json({ revision: digest(disk.text) });
    }
    throw new Error('Unexpected provider operation ' + operation);
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => { assert.equal(name, 'vscode'); return vscode; }, fetch, URL, Uint8Array, TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder, AbortController, AbortSignal, crypto: webcrypto, atob: globalThis.atob, btoa: globalThis.btoa, setTimeout, clearTimeout, console });
  const workspaceState = { get: (_key, fallback) => globalThis.structuredClone(persisted.value ?? fallback), update: async (_key, value) => { if (options.barrier) await options.barrier; persisted.value = globalThis.structuredClone(value); } };
  await module.exports.activate({ extensionUri: new Uri({ scheme: 'https', authority: 'code.example.invalid', path: '/extension' }), workspaceState, subscriptions });
  disposables.push(...subscriptions);
  const uri = root.with({ path: '/file.ts' });
  document = { uri, isDirty: false, getText: () => document.text, text: disk.text, save: async () => { await provider.writeFile(uri, Buffer.from(document.text), { create: true, overwrite: true }); document.isDirty = false; return true; } };
  documents.push(document); vscode.window.activeTextEditor = { document };
  return { provider, uri, document, commands, choices, comparisons, opened, themes, writes: () => writes, close: () => { for (const disposable of disposables.reverse()) disposable.dispose(); } };
}

test('a save cannot leave the workbench before its durable sending claim is confirmed', async () => {
  const persisted = {}, disk = { text: 'original' }, options = {};
  const editor = await mount(persisted, disk, options);
  try {
    await editor.provider.readFile(editor.uri);
    let release; options.barrier = new Promise(resolve => { release = resolve; });
    const saving = editor.provider.writeFile(editor.uri, Buffer.from('new version'), { create: true, overwrite: true });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(editor.writes(), 0);
    release(); await saving;
    assert.equal(editor.writes(), 1); assert.equal(disk.text, 'new version');
    assert.equal(persisted.value[0].pending, null);
  } finally { editor.close(); }
});

test('unknown writes remain blocked after an extension/workbench restart until explicit revision reconciliation', async () => {
  const persisted = {}, disk = { text: 'original' }, options = { dropWrite: true };
  let editor = await mount(persisted, disk, options);
  await editor.provider.readFile(editor.uri); editor.document.isDirty = true;
  await assert.rejects(editor.provider.writeFile(editor.uri, Buffer.from('my edits'), { create: true, overwrite: true }));
  assert.ok(persisted.value[0].pending); assert.equal(editor.writes(), 1); editor.close();
  disk.text = 'external changes';
  editor = await mount(persisted, disk);
  try {
    editor.document.text = 'my retained edits'; editor.document.isDirty = true;
    await editor.provider.readFile(editor.uri);
    await assert.rejects(editor.provider.writeFile(editor.uri, Buffer.from('my retained edits'), { create: true, overwrite: true }), /Inspect/);
    assert.equal(editor.writes(), 0); assert.equal(disk.text, 'external changes');
    editor.choices.push('Compare with disk', 'Save my version');
    await editor.commands.get('elevenex.code.reconcile-save')();
    assert.equal(editor.comparisons[0][0], 'vscode.diff');
    assert.equal(disk.text, 'my retained edits'); assert.equal(editor.writes(), 1); assert.equal(persisted.value[0].pending, null);
  } finally { editor.close(); }
});

test('restored dirty text cannot save into a replacement checkout generation without comparison', async () => {
  const persisted = {}, disk = { text: 'original', generation: 'a'.repeat(64) };
  let editor = await mount(persisted, disk);
  await editor.provider.readFile(editor.uri); editor.document.isDirty = true; editor.close();
  disk.generation = 'b'.repeat(64); disk.text = 'replacement checkout';
  editor = await mount(persisted, disk);
  try {
    editor.document.isDirty = true; editor.document.text = 'retained original edits';
    await editor.provider.readFile(editor.uri);
    await assert.rejects(editor.provider.writeFile(editor.uri, Buffer.from(editor.document.text), { create: true, overwrite: true }), /Workspace changed/);
    assert.equal(editor.writes(), 0); assert.equal(disk.text, 'replacement checkout');
    editor.choices.push('Compare with disk', 'Save my version');
    await editor.commands.get('elevenex.code.reconcile-save')();
    assert.equal(disk.text, 'retained original edits'); assert.equal(persisted.value[0].generation, 'b'.repeat(64));
  } finally { editor.close(); }
});

test('an upstream hot-exit document can save its retained baseline without rereading and adopting disk', async () => {
  const persisted = {}, disk = { text: 'original' };
  let editor = await mount(persisted, disk);
  await editor.provider.readFile(editor.uri); editor.close();
  editor = await mount(persisted, disk);
  try {
    editor.document.isDirty = true; editor.document.text = 'hot-exit buffer';
    await editor.provider.writeFile(editor.uri, Buffer.from(editor.document.text), { create: true, overwrite: true });
    assert.equal(disk.text, 'hot-exit buffer'); assert.equal(editor.writes(), 1);
  } finally { editor.close(); }
});


test('host file intents use task URIs and supported zero-based ranges; shell theme updates the workbench', async () => {
  const options = { dark: false };
  const editor = await mount({}, { text: 'original' }, options);
  try {
    assert.equal(editor.themes.at(-1).value, 'Light Modern');
    await editor.commands.get('elevenex.code.open-file')('src/unicode é.ts', 7, 3);
    assert.equal(editor.opened.at(-1).uri.path, '/src/unicode é.ts');
    assert.deepEqual(Array.from(editor.opened.at(-1).options.selection.args), [6, 2, 6, 2]);
    await assert.rejects(editor.commands.get('elevenex.code.open-file')('../escape', 1, 1));
    options.dark = true; await editor.provider.stat(editor.uri);
    assert.equal(editor.themes.at(-1).value, 'Dark Modern');
  } finally { editor.close(); }
});


test('a reattached transport reconciles Explorer once without a filesystem change or a whole-tree snapshot', async () => {
  const options = { transportRevision: 0, pausedChanges: false };
  const editor = await mount({}, { text: 'original' }, options);
  const events = [], listener = editor.provider.onDidChangeFile(changes => events.push(...changes));
  try {
    options.transportRevision = 1;
    await editor.commands.get('elevenex.code.reconnect')();
    assert.ok(events.some(event => event.uri.path === '/'));
    events.length = 0;
    await editor.commands.get('elevenex.code.reconnect')();
    assert.equal(events.filter(event => event.uri.path === '/').length, 0);
  } finally { listener.dispose(); editor.close(); }
});
