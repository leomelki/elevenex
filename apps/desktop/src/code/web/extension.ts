import { registerTransfers } from './transfers';
import { CompactLayout } from './compact-layout';
import * as vscode from 'vscode';
import type { Changes, DirectoryPage, FileRead, SearchPage } from './contracts';

const SCHEME = 'elevenex-task';
const containsPath = (parent: string, path: string) => path === parent || path.startsWith(parent + '/');
function movePaths<T>(values: Map<string, T>, source: string, target: string): void {
  for (const [path, value] of [...values]) if (containsPath(source, path)) { values.delete(path); values.set(target + path.slice(source.length), value); }
}
interface SaveEntry { readonly path: string; readonly generation: string; readonly revision: string | null; readonly pending: string | null; readonly dirty: boolean }
/** Durable digests accompany upstream hot-exit buffers. Persist before dispatch,
 * so a crashed/unknown write can never be blindly replayed after reopening. */
class SaveLedger {
  private readonly entries = new Map<string, SaveEntry>();
  private valid = true;
  constructor(private readonly storage: vscode.Memento) {
    const saved = storage.get<unknown>('task-save-ledger', []);
    if (!Array.isArray(saved) || saved.length > 256 || JSON.stringify(saved).length > 128 * 1024) { this.valid = false; return; }
    for (const raw of saved) {
      if (!raw || typeof raw !== 'object' || !('generation' in raw) || typeof raw.generation !== 'string' || !/^[a-f0-9]{64}$/.test(raw.generation) || !('path' in raw) || typeof raw.path !== 'string' || raw.path.length > 4096 || !('revision' in raw) || raw.revision !== null && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) || !('pending' in raw) || raw.pending !== null && (typeof raw.pending !== 'string' || !/^[a-f0-9]{64}$/.test(raw.pending))) { this.valid = false; this.entries.clear(); return; }
      this.entries.set(raw.path, { path: raw.path, generation: raw.generation, revision: raw.revision, pending: raw.pending, dirty: 'dirty' in raw && raw.dirty === true });
    }
  }
  generation(path: string): string | undefined { return this.entries.get(path)?.generation; }
  baseline(path: string): string | null | undefined { return this.entries.get(path)?.revision; }
  pending(path: string): boolean { return this.entries.get(path)?.pending !== null && this.entries.has(path); }
  pendingPaths(): string[] { return [...this.entries.values()].filter(entry => entry.pending !== null).map(entry => entry.path); }
  async remember(path: string, revision: string, generation: string, preservePending = false): Promise<void> {
    await this.save({ path, generation, revision, dirty: this.entries.get(path)?.dirty ?? false, pending: preservePending ? this.entries.get(path)?.pending ?? null : null });
  }
  async begin(path: string, revision: string | null, generation: string, content: Uint8Array): Promise<void> {
    const bytes = new Uint8Array(content.length); bytes.set(content);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    await this.save({ path, generation, revision, pending: digest, dirty: this.entries.get(path)?.dirty ?? false });
  }
  async markDirty(path: string, dirty: boolean): Promise<void> { const entry = this.entries.get(path); if (entry && entry.dirty !== dirty) await this.save({ ...entry, dirty }); }
  async forget(path: string): Promise<void> {
    this.entries.delete(path);
    await this.storage.update('task-save-ledger', [...this.entries.values()]);
  }
  assertRename(source: string, target: string): void {
    if ([...this.entries.values()].some(entry => containsPath(target, entry.path) && !containsPath(source, entry.path) && (entry.dirty || entry.pending !== null))) throw vscode.FileSystemError.Unavailable('The destination has retained edits. Inspect them before renaming.');
  }
  async rename(source: string, target: string): Promise<void> {
    const next = new Map(this.entries);
    movePaths(next, source, target);
    const entries = [...next].map(([path, entry]) => ({ ...entry, path }));
    if (JSON.stringify(entries).length > 128 * 1024) throw vscode.FileSystemError.Unavailable('The renamed save journal exceeds its limit. Inspect retained edits before saving.');
    this.entries.clear(); for (const entry of entries) this.entries.set(entry.path, entry);
    await this.storage.update('task-save-ledger', entries);
  }
  private async save(entry: SaveEntry): Promise<void> {
    if (!this.valid) throw vscode.FileSystemError.Unavailable('The save journal is unavailable. Retain your unsaved copy and inspect disk before saving.');
    const previous = this.entries.get(entry.path); this.entries.delete(entry.path); this.entries.set(entry.path, entry);
    while (this.entries.size > 256 || JSON.stringify([...this.entries.values()]).length > 128 * 1024) {
      const clean = [...this.entries.values()].find(value => value.path !== entry.path && value.pending === null && !value.dirty && !vscode.workspace.textDocuments.some(document => document.uri.scheme === SCHEME && document.uri.path === value.path));
      if (!clean) { this.entries.delete(entry.path); if (previous) this.entries.set(entry.path, previous); throw vscode.FileSystemError.Unavailable('Too many retained saves. Inspect and save another file first.'); }
      this.entries.delete(clean.path);
    }
    await this.storage.update('task-save-ledger', [...this.entries.values()]);
  }
}
class TaskFiles implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private generation = '';
  private transportRevision = -1;
  private generationTick = 0;
  private readonly directoryGenerations = new Map<string, string>();
  private readonly candidateReads = new Map<string, { readonly revision: string; readonly generation: string; readonly textHash: string }>();
  private readonly versions = new Map<string, string>();
  private readonly revisions = new Map<string, string>();
  private readonly pendingWrites = new Set<string>();
  private readonly blockedSaves = new Set<string>();
  private readonly comparing = new Set<string>();
  private readonly diskCopies = new Map<string, string>();
  private readonly requests = new Set<AbortController>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  private dark?: boolean;
  private embedded?: boolean;
  private reconcileRoot = false;
  private unknownSave = false;
  constructor(private readonly base: vscode.Uri, private readonly root: vscode.Uri, private readonly ledger: SaveLedger) {
    for (const path of ledger.pendingPaths()) this.blockedSaves.add(path); this.unknownSave = this.blockedSaves.size > 0;
    this.status.command = this.unknownSave ? 'elevenex.code.reconcile-save' : 'elevenex.code.reconnect'; this.state('$(sync) Connecting to task');
  }
  async start(): Promise<void> { await vscode.workspace.fs.stat(this.root); await this.call('ready', { dirty: 0 }); this.schedule(0); }
  async setTheme(dark: boolean): Promise<void> {
    if (this.dark === dark) return;
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', dark ? 'Dark Modern' : 'Light Modern', vscode.ConfigurationTarget.Global);
    this.dark = dark;
  }
  dispose(): void {
    this.stopped = true; clearTimeout(this.timer);
    for (const request of this.requests) request.abort();
    this.requests.clear(); this.status.dispose(); this.changed.dispose(); this.revisions.clear(); this.versions.clear(); this.diskCopies.clear(); this.blockedSaves.clear(); this.candidateReads.clear(); this.directoryGenerations.clear();
  }
  private path(uri: vscode.Uri): string {
    if (uri.scheme !== SCHEME || uri.authority !== this.root.authority || uri.query || uri.fragment || !uri.path.startsWith('/') || uri.path.split('/').some(p => p === '..' || p === '.' || p.toLowerCase() === '.git')) throw vscode.FileSystemError.NoPermissions('File is outside this task.');
    return uri.path;
  }
  async call<T>(operation: string, input: object = {}, signal?: AbortSignal): Promise<T> {
    if (this.stopped) throw vscode.FileSystemError.Unavailable('Editor closed.');
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(vscode.Uri.joinPath(this.base, 'api', operation).toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: this.generation, transportRevision: this.transportRevision, ...input }), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) {
        if (response.status === 403) throw Object.assign(vscode.FileSystemError.NoPermissions('This file is read-only. Your unsaved copy is retained.'), { readonlyFile: true });
        if (response.status === 404) throw vscode.FileSystemError.FileNotFound();
        if (response.status === 409) {
          const value: unknown = await response.json();
          if (value && typeof value === 'object' && 'error' in value && value.error === 'file-changing') throw vscode.FileSystemError.Unavailable('File is changing. Try again when the current write finishes.');
          if (value && typeof value === 'object' && 'error' in value && value.error === 'target-exists') throw vscode.FileSystemError.FileExists();
          const fileConflict = !!value && typeof value === 'object' && 'error' in value && value.error === 'file-conflict';
          throw Object.assign(vscode.FileSystemError.NoPermissions(fileConflict ? 'File changed on disk. Compare your unsaved copy before saving.' : 'Task workspace changed. Reopen Code and recover retained edits.'), { fileConflict });
        }
        throw vscode.FileSystemError.Unavailable('Machine disconnected or operation failed. Your unsaved edits remain here. Reconnect, then explicitly save again.');
      }
      // The isolated main-process protocol validates these domain replies.
      const value: unknown = await response.json();
      // Electron owns the shell theme. Its isolated surface does not inherit the
      // shell's emulated media or data-theme, so reconcile through supported API.
      if (value && typeof value === 'object' && 'dark' in value && typeof value.dark === 'boolean' && value.dark !== this.dark) {
        await this.setTheme(value.dark);
      }
      if (value && typeof value === 'object' && 'embedded' in value && typeof value.embedded === 'boolean' && value.embedded !== this.embedded) {
        await vscode.commands.executeCommand('setContext', 'elevenex.embedded', value.embedded); this.embedded = value.embedded;
      }
      if (value && typeof value === 'object' && 'generation' in value && typeof value.generation === 'string' && /^[a-f0-9]{64}$/.test(value.generation)) { if (this.generation && this.generation !== value.generation) this.generationTick++; this.generation = value.generation; }
      if (value && typeof value === 'object' && 'transportRevision' in value && typeof value.transportRevision === 'number' && Number.isSafeInteger(value.transportRevision) && value.transportRevision >= 0) {
        if (this.transportRevision >= 0 && value.transportRevision !== this.transportRevision) this.reconcileRoot = true;
        this.transportRevision = value.transportRevision;
      }
      return value as T;
    } finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> { const path = this.path(uri), value = await this.call<vscode.FileStat>('stat', { path }); value.mtime += this.generationTick; if (value.type === vscode.FileType.File && !this.versions.has(path)) { if (this.versions.size >= 128) this.versions.delete(this.versions.keys().next().value!); this.versions.set(path, `${value.mtime}:${value.size}`); } return value; }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const path = this.path(uri), entries: [string, vscode.FileType][] = []; let after: string | undefined, generation: string | undefined;
    // Upstream's provider API returns one directory. Transport is paged; no tree snapshot.
    do {
      const page = await this.call<DirectoryPage>('directory', { path, after });
      if (generation && generation !== page.generation) throw vscode.FileSystemError.Unavailable('Workspace changed while loading this folder. Reopen it.');
      generation = page.generation;
      for (const item of page.entries) entries.push([item.name, item.type]);
      after = page.next ?? undefined;
      if (entries.length >= 10_000 && after) {
        void vscode.window.showWarningMessage('This folder has more than 10,000 entries. Use Quick Open to find other files.'); break;
      }
    } while (after);
    if (generation) { if (this.directoryGenerations.size >= 128) this.directoryGenerations.delete(this.directoryGenerations.keys().next().value!); this.directoryGenerations.set(path, generation); }
    return entries;
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const path = this.path(uri), result = await this.call<FileRead>('read', { path });
    const bytes = Uint8Array.from(atob(result.content), c => c.charCodeAt(0));
    if (this.ledger.baseline(path) === undefined) await this.ledger.remember(path, result.revision, result.generation);
    else if (!this.ledger.pending(path) && (this.ledger.baseline(path) !== result.revision || this.ledger.generation(path) !== result.generation)) {
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      const textHash = await this.textHash(new TextDecoder(encoding).decode(bytes));
      if (this.candidateReads.size >= 64) this.candidateReads.delete(this.candidateReads.keys().next().value!);
      this.candidateReads.set(path, { revision: result.revision, generation: result.generation, textHash });
    }
    this.remember(path, this.ledger.baseline(path) ?? result.revision);
    return bytes;
  }
  async documentChanged(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== SCHEME || this.stopped) return;
    await this.ledger.markDirty(document.uri.path, document.isDirty).catch(() => { this.blockedSaves.add(document.uri.path); this.unknownSave = true; this.status.command = 'elevenex.code.reconcile-save'; this.state('$(warning) File version needs inspection'); });
    if (document.isDirty) return;
    const path = document.uri.path, candidate = this.candidateReads.get(path), version = document.version;
    if (!candidate || this.ledger.pending(path)) return;
    const hash = await this.textHash(document.getText());
    if (document.isDirty || document.version !== version || this.candidateReads.get(path) !== candidate || hash !== candidate.textHash) return;
    try { await this.ledger.remember(path, candidate.revision, candidate.generation); this.remember(path, candidate.revision); this.candidateReads.delete(path); }
    catch { this.blockedSaves.add(path); this.unknownSave = true; this.status.command = 'elevenex.code.reconcile-save'; this.state('$(warning) File version needs inspection'); }
  }
  private async textHash(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  private resourceGeneration(path: string): string {
    const saved = this.ledger.generation(path); if (saved) return saved;
    let directory = path;
    while (directory) { const generation = this.directoryGenerations.get(directory); if (generation) return generation; directory = directory.slice(0, directory.lastIndexOf('/')); }
    return this.directoryGenerations.get('/') ?? this.generation;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const path = this.path(uri), revision = this.revisions.get(path) ?? this.ledger.baseline(path) ?? undefined;
    if (this.blockedSaves.has(path)) throw vscode.FileSystemError.Unavailable('Inspect the unconfirmed save before retrying. Click the editor status to compare with disk.');
    const generation = this.resourceGeneration(path), transportRevision = this.transportRevision;
    if (generation !== this.generation) { this.blockedSaves.add(path); this.unknownSave = true; this.status.command = 'elevenex.code.reconcile-save'; this.state('$(warning) Workspace changed · inspect retained edits'); throw vscode.FileSystemError.NoPermissions('Workspace changed. Compare the retained file with disk before saving.'); }
    if (!options.create || !options.overwrite) {
      const exists = await this.stat(uri).then(() => true, error => {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return false;
        throw error;
      });
      if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (revision === undefined && (!options.create || options.overwrite)) {
      // Untitled Save As may create a new resource, but must never overwrite an
      // existing resource whose original revision this document has not read.
      try { await this.stat(uri); this.blockedSaves.add(path); this.unknownSave = true; this.status.command = 'elevenex.code.reconcile-save'; this.state('$(warning) Original file version needs inspection'); void this.compareSave(uri); throw vscode.FileSystemError.NoPermissions('Compare the retained file with disk before replacing it.'); }
      catch (e) { if (!(e instanceof vscode.FileSystemError) || e.code !== 'FileNotFound') throw e; }
    }
    if (this.pendingWrites.has(path)) throw vscode.FileSystemError.Unavailable('A save is already in progress for this file.');
    this.pendingWrites.add(path);
    this.state('$(sync~spin) Saving…');
    let binary = ''; for (let at = 0; at < content.length; at += 8192) binary += String.fromCharCode(...content.subarray(at, at + 8192));
    try {
      await this.ledger.begin(path, revision ?? null, generation, content);
      const result = await this.call<{ revision: string }>('write', { path, content: btoa(binary), revision: revision ?? null, generation, transportRevision });
      await this.ledger.remember(path, result.revision, this.generation); this.remember(path, result.revision); this.unknownSave = this.blockedSaves.size > 0; this.status.command = this.unknownSave ? 'elevenex.code.reconcile-save' : 'elevenex.code.reconnect'; this.state(this.unknownSave ? '$(warning) Another save needs inspection' : '$(check) Saved');
      this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'NoPermissions') { this.unknownSave = true; this.blockedSaves.add(path); this.status.command = 'elevenex.code.reconcile-save'; this.state('readonlyFile' in error && error.readonlyFile ? '$(lock) Read-only · edits retained' : '$(warning) Save blocked · inspect retained edits'); if ('fileConflict' in error && error.fileConflict) void this.compareSave(uri); throw error; }
      this.unknownSave = true; this.state('$(warning) Save unconfirmed · edits retained');
      // Read-only reconciliation; never replay a mutation after transport loss.
      try {
        const saved = await this.call<FileRead>('read', { path });
        if (saved.content === btoa(binary)) { await this.ledger.remember(path, saved.revision, saved.generation); this.remember(path, saved.revision); this.unknownSave = this.blockedSaves.size > 0; this.status.command = this.unknownSave ? 'elevenex.code.reconcile-save' : 'elevenex.code.reconnect'; this.state(this.unknownSave ? '$(warning) Another save needs inspection' : '$(check) Save confirmed'); return; }
      } catch { /* The dirty buffer remains the recovery copy. */ }
      this.blockedSaves.add(path); this.status.command = 'elevenex.code.reconcile-save';
      throw error;
    } finally { this.pendingWrites.delete(path); }
  }
  diskCopy(uri: vscode.Uri): string { return this.diskCopies.get(uri.toString()) ?? 'This comparison has expired. Compare with disk again.'; }
  async reconcileSave(): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const path = active?.scheme === SCHEME && this.blockedSaves.has(active.path) ? active.path : this.blockedSaves.values().next().value;
    if (path) await this.compareSave(this.root.with({ path }));
  }
  private async compareSave(uri: vscode.Uri): Promise<void> {
    const path = this.path(uri); if (this.comparing.has(path) || this.stopped) return;
    this.comparing.add(path);
    try {
      if (await vscode.window.showWarningMessage('Your unsaved copy is retained. Inspect the current file before saving again.', 'Compare with disk') !== 'Compare with disk' || this.stopped) return;
      const current = await this.call<FileRead>('read', { path });
      const bytes = Uint8Array.from(atob(current.content), c => c.charCodeAt(0));
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      const disk = vscode.Uri.from({ scheme: 'elevenex-disk', authority: this.root.authority, path: '/' + crypto.randomUUID() + path });
      if (this.diskCopies.size >= 4) this.diskCopies.delete(this.diskCopies.keys().next().value!);
      this.diskCopies.set(disk.toString(), new TextDecoder(encoding).decode(bytes));
      await vscode.commands.executeCommand('vscode.diff', disk, uri, 'Disk ↔ your unsaved copy', { preview: false });
      if (await vscode.window.showWarningMessage('Save your version over the disk revision shown in this comparison?', 'Save my version', 'Keep editing') !== 'Save my version' || this.stopped) return;
      const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      if (!document?.isDirty) return;
      await this.ledger.remember(path, current.revision, current.generation); this.remember(path, current.revision); this.blockedSaves.delete(path); this.unknownSave = this.blockedSaves.size > 0;
      this.status.command = this.unknownSave ? 'elevenex.code.reconcile-save' : 'elevenex.code.reconnect';
      await document.save();
    } catch { this.state('$(warning) Comparison unavailable · edits retained'); }
    finally { this.comparing.delete(path); }
  }
  async createDirectory(uri: vscode.Uri): Promise<void> { await this.call('mkdir', { path: this.path(uri), generation: this.resourceGeneration(this.path(uri)) }); this.changed.fire([{ type: vscode.FileChangeType.Created, uri }]); }
  async delete(uri: vscode.Uri): Promise<void> {
    const path = this.path(uri), transportRevision = this.transportRevision, generation = this.resourceGeneration(this.path(uri));
    let revision = this.revisions.get(path);
    if (this.blockedSaves.has(path)) throw vscode.FileSystemError.Unavailable('Inspect the unconfirmed save before deleting this file.');
    if (generation !== this.generation) throw vscode.FileSystemError.NoPermissions('Workspace changed. Reload the folder before deleting this file.');
    if (revision === undefined && (await this.stat(uri)).type === vscode.FileType.File) revision = (await this.call<FileRead>('read', { path })).revision;
    await this.call('delete', { path, revision, generation, transportRevision });
    await this.ledger.forget(path);
    this.revisions.delete(path); this.versions.delete(path); this.candidateReads.delete(path); this.directoryGenerations.delete(path);
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (options.overwrite) throw vscode.FileSystemError.NoPermissions('Choose a new name; replacing another file is not supported.');
    const source = this.path(oldUri), target = this.path(newUri);
    if ([...this.blockedSaves, ...this.pendingWrites].some(path => containsPath(source, path))) throw vscode.FileSystemError.Unavailable('Inspect or finish retained saves before renaming this file or folder.');
    this.ledger.assertRename(source, target);
    await this.call('rename', { path: source, target, generation: this.resourceGeneration(source) });
    await this.ledger.rename(source, target);
    movePaths(this.revisions, source, target); movePaths(this.versions, source, target);
    movePaths(this.directoryGenerations, source, target); movePaths(this.candidateReads, source, target);
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
  }
  async reconnect(): Promise<void> { if (this.failures) this.reconcileRoot = true; this.failures = 0; clearTimeout(this.timer); await this.poll(); }
  private remember(path: string, revision: string) {
    this.revisions.delete(path); this.revisions.set(path, revision);
    if (this.revisions.size > 1024) this.revisions.delete(this.revisions.keys().next().value!);
  }
  private state(text: string) { this.status.text = text; this.status.tooltip = this.blockedSaves.size ? 'Click to compare an unconfirmed save with disk. Unsaved buffers are retained.' : 'Files belong to this task. Click to reconnect. Unsaved buffers stay in this workbench.'; this.status.show(); }
  private schedule(ms: number) { if (!this.stopped) this.timer = setTimeout(() => void this.poll(), ms); }
  private async poll(): Promise<void> {
    try {
      const changes = await this.call<Changes>('changes', { after: this.sequence });
      if (changes.paused) { this.schedule(1500); return; }
      this.sequence = changes.sequence;
      // A previous lease can fail an Explorer read during reattachment. A new
      // lease must invalidate that visible error even without filesystem events.
      const events = (changes.reset || this.reconcileRoot || this.failures ? ['/'] : changes.paths).map(path => ({ type: vscode.FileChangeType.Changed, uri: this.root.with({ path }) }));
      this.reconcileRoot = false;
      if (events.length) this.changed.fire(events);
      // Open documents reconcile their own revisions without replacing dirty text.
      for (const document of vscode.workspace.textDocuments.slice(0, 32)) {
        if (document.uri.scheme !== SCHEME || document.isDirty) continue;
        const stat = await this.stat(document.uri).catch(error => {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return null;
          // A transport or workspace failure says nothing about file existence.
          // Retain the model and let the owning poll report disconnection.
          throw error;
        });
        const path = document.uri.path, previous = this.versions.get(path);
        if (!stat) { if (previous) this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri: document.uri }]); this.versions.delete(path); continue; }
        const version = `${stat.mtime}:${stat.size}`;
        if (events.length || previous !== undefined && previous !== version) this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: document.uri }]);
        this.versions.set(path, version);
      }
      this.failures = 0;
      if (!this.unknownSave) this.state('$(check) Task connected');
      await this.call('ready', { dirty: vscode.workspace.textDocuments.filter(d => d.isDirty).length }); this.schedule(1500);
    } catch {
      this.state(this.unknownSave ? '$(warning) Disconnected · save unconfirmed' : '$(debug-disconnect) Disconnected · edits retained');
      this.failures++;
      // Stop after ten minutes; the named reconnect action remains available.
      if (this.failures < 44) this.schedule(Math.min(15_000, 1000 * 2 ** Math.min(4, this.failures)));
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || root.scheme !== SCHEME) return;
  const base = context.extensionUri.with({ path: '/', query: '', fragment: '' });
  const files = new TaskFiles(base, root, new SaveLedger(context.workspaceState));
  registerTransfers(context, root, (operation, input) => files.call(operation, input));
  const layout = new CompactLayout(context.workspaceState, (filesOpen, hasEditors) => files.call('presentation', {filesOpen, hasEditors}));
  context.subscriptions.push(layout,
    vscode.commands.registerCommand('elevenex.code.find-file', () => vscode.commands.executeCommand('workbench.action.quickOpen')),
    vscode.commands.registerCommand('elevenex.code.browse-files', () => layout.browse()),
    vscode.commands.registerCommand('elevenex.code.dismiss-files', () => layout.dismiss()),
    vscode.commands.registerCommand('elevenex.code.focus', () => layout.focus()),
  );
  context.subscriptions.push(vscode.commands.registerCommand('elevenex.code.set-compact', (compact: unknown) => {
    if (typeof compact !== 'boolean') throw new Error('Invalid editor layout.');
    return layout.set(compact);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('elevenex.code.return-to-chat', () => files.call('return-to-chat')));
  context.subscriptions.push(vscode.commands.registerCommand('elevenex.code.set-theme', (dark: unknown) => { if (typeof dark !== 'boolean') throw new Error('Invalid editor theme.'); return files.setTheme(dark); }));
  context.subscriptions.push(vscode.commands.registerCommand('elevenex.code.open-file', async (path: unknown, line: unknown, column: unknown) => {
    if (typeof path !== 'string' || path.length > 4096 || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1) throw new Error('Invalid task file position.');
    await layout.revealEditor();
    try {
      await vscode.window.showTextDocument(root.with({ path: '/' + path }), { preview: false, preserveFocus: false, selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1) });
    } catch (error) { await layout.focus(); throw error; }
  }));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => { void files.documentChanged(document); }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { void files.documentChanged(event.document); void files.call('ready', { dirty: vscode.workspace.textDocuments.filter(d => d.isDirty).length }).catch(() => undefined); }));
  context.subscriptions.push(files, vscode.workspace.registerFileSystemProvider(SCHEME, files, { isCaseSensitive: true }), vscode.commands.registerCommand('elevenex.code.reconnect', () => files.reconnect()), vscode.commands.registerCommand('elevenex.code.reconcile-save', () => files.reconcileSave()), vscode.workspace.registerTextDocumentContentProvider('elevenex-disk', { provideTextDocumentContent: uri => files.diskCopy(uri) }));
  context.subscriptions.push(vscode.workspace.registerFileSearchProvider(SCHEME, {
    async provideFileSearchResults(query, options, token) {
      const controller = new AbortController(), cancel = token.onCancellationRequested(() => controller.abort());
      try {
        const result = await files.call<{ paths: string[] }>('filenames', { query: query.pattern, limit: Math.min(200, options.maxResults ?? 200), folder: options.folder.path, includes: options.includes.slice(0, 20), excludes: options.excludes.slice(0, 20), useIgnoreFiles: options.useIgnoreFiles }, controller.signal);
        return token.isCancellationRequested ? [] : result.paths.map(path => root.with({ path }));
      } finally { cancel.dispose(); }
    },
  }));
  context.subscriptions.push(vscode.workspace.registerTextSearchProvider(SCHEME, {
    async provideTextSearchResults(query, options, progress, token) {
      const controller = new AbortController(); let id: string | undefined;
      const cancel = token.onCancellationRequested(() => { controller.abort(); if (id) void files.call('search-cancel', { id }).catch(() => undefined); });
      try {
        let page = await files.call<SearchPage>('search', { query: query.pattern, folder: options.folder.path, regex: query.isRegExp, caseSensitive: query.isCaseSensitive, word: query.isWordMatch, limit: Math.min(2000, options.maxResults || 2000), includes: options.includes.slice(0, 20), excludes: options.excludes.slice(0, 20), useIgnoreFiles: options.useIgnoreFiles }, controller.signal);
        id = page.id;
        for (;;) {
          if (token.isCancellationRequested) return { limitHit: false };
          for (const row of page.rows) {
            const offset = Math.max(0, row.start - 100);
            progress.report({ uri: root.with({ path: row.path }), ranges: new vscode.Range(row.line, row.start, row.line, row.end), preview: { text: row.text, matches: new vscode.Range(0, row.start - offset, 0, Math.min(row.text.length, row.end - offset)) } });
          }
          if (page.error) throw new Error(page.error);
          if (page.done) return { limitHit: page.limited };
          page = await files.call<SearchPage>('search-page', { id }, controller.signal);
        }
      } finally { cancel.dispose(); if (id) void files.call('search-cancel', { id }).catch(() => undefined); }
    },
  }));
  await files.start();
}
