import { DestroyRef, PendingTasks, computed, effect, inject, signal, type Signal } from '@angular/core';
import type { FolderEntry, FolderProvider } from './project.models';

interface FolderWindow {
  readonly query: string;
  readonly entries: readonly FolderEntry[];
}
interface FolderSourceInputs {
  readonly query: Signal<string>;
  readonly provider: Signal<FolderProvider | undefined>;
  readonly active: Signal<boolean>;
  readonly composing: Signal<boolean>;
}

/** One picker's bounded directory windows and request lifetime; no platform access. */
export class FolderSuggestionsSource {
  private readonly windows = signal<readonly FolderWindow[]>([]);
  private readonly reply = signal<{ readonly query: string; readonly failed: boolean } | null>(null);
  private readonly running = signal(false);
  private readonly version = signal(0);
  private readonly destroy = inject(DestroyRef);
  private readonly tasks = inject(PendingTasks);
  readonly showPending = signal(false);
  readonly items = computed(() => {
    const query = this.inputs.query();
    if (!this.inputs.active() || !query || this.error()) return [];
    const windows = this.windows();
    const exact = windows.find(window => window.query === query);
    if (exact) return exact.entries;
    const part = pathParts(query);
    if (!part) return [];
    // Prefer a broader parent listing over a previously narrowed result window.
    const compatible = windows.filter(window => pathParts(window.query)?.parent === part.parent)
      .sort((a, b) => (pathParts(a.query)?.prefix.length ?? 0) - (pathParts(b.query)?.prefix.length ?? 0))[0];
    if (!compatible) return [];
    const entries = compatible.entries.filter(entry => !entry.clone && entryName(entry).toLowerCase().startsWith(part.prefix));
    const folder = entries.find(entry => entryName(entry).toLowerCase() === part.prefix);
    return folder && part.prefix ? [folder] : entries;
  });
  readonly ready = computed(() => !this.running() && this.reply()?.query === this.inputs.query());
  readonly error = computed(() => this.reply()?.query === this.inputs.query() && this.reply()?.failed === true);
  readonly pending = computed(() => this.inputs.active() && !this.inputs.composing() && !!this.inputs.query() && !!this.inputs.provider() && !this.ready());
  readonly placeholderCount = computed(() => Math.max(1, Math.min(5, this.windows()[0]?.entries.length ?? 1)));

  constructor(private readonly inputs: FolderSourceInputs) {
    let previousProvider: FolderProvider | undefined;
    effect(onCleanup => {
      this.version();
      const query = inputs.query(), provider = inputs.provider(), active = inputs.active(), composing = inputs.composing();
      if (!active || provider !== previousProvider) this.windows.set([]);
      previousProvider = provider;
      this.reply.set(null);
      this.showPending.set(false);
      if (!active || !provider || !query || composing) { this.running.set(false); return; }
      const controller = new AbortController();
      let current = true;
      let finishPending: (() => void) | undefined = this.tasks.add();
      const finish = () => { finishPending?.(); finishPending = undefined; clearTimeout(timer); };
      const timer = setTimeout(() => { if (current) this.showPending.set(true); }, 150);
      onCleanup(() => { current = false; controller.abort(); finish(); });
      this.running.set(true);
      Promise.resolve().then(() => provider(query, controller.signal)).then(entries => {
        if (!current || controller.signal.aborted || this.destroy.destroyed) return;
        const seen = new Set<string>();
        const bounded: FolderEntry[] = [];
        for (const entry of entries) {
          if (!entry.path || seen.has(entry.path)) continue;
          seen.add(entry.path); bounded.push(entry);
          if (bounded.length === 50) break;
        }
        this.windows.update(windows => [{ query, entries: bounded }, ...windows.filter(window => window.query !== query)].slice(0, 8));
        this.reply.set({ query, failed: false });
        this.running.set(false); this.showPending.set(false); finish();
      }, () => {
        if (!current || controller.signal.aborted || this.destroy.destroyed) return;
        this.reply.set({ query, failed: true });
        this.running.set(false); this.showPending.set(false); finish();
      });
    });
  }

  retry(): void { this.version.update(version => version + 1); }
}

function pathParts(query: string): { readonly parent: string; readonly prefix: string } | null {
  if (/^(git@|https?:|ssh:)/i.test(query)) return null;
  const separator = query.lastIndexOf('/');
  if (separator < 0) return null;
  return { parent: query.slice(0, separator + 1), prefix: query.slice(separator + 1).toLowerCase() };
}
function entryName(entry: FolderEntry): string {
  return entry.path.replace(/\/+$/, '').split('/').pop() || entry.name || entry.path;
}

/** Preserve the person's ~/ notation rather than expanding it into a long machine path. */
export function completedFolderPath(query: string, entry: FolderEntry): string {
  const path = entry.path.replace(/\/?$/, '/');
  if (!query.startsWith('~/')) return path;
  const parent = query.slice(0, query.lastIndexOf('/') + 1);
  const suffix = parent.slice(1) + entryName(entry) + '/';
  return path.endsWith(suffix) ? parent + entryName(entry) + '/' : path;
}
