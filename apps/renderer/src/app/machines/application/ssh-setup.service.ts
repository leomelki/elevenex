import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import type { RemoteHostInput } from '@elevenex/shared';
import type { PickedHost, SshHost } from '../index';
import { MachineConnectionService } from './machine-connection.service';
import { MachineLauncherService } from './machine-launcher.service';
import { parseSshDestination } from './machine-presentation';

/** Owns one unfinished host draft; SSH itself owns authentication and host trust. */
@Injectable()
export class SshSetupService {
  private readonly connection = inject(MachineConnectionService);
  private readonly launcher = inject(MachineLauncherService);
  private readonly destroy = inject(DestroyRef);
  readonly open = signal(false);
  readonly from = signal<HTMLElement | null>(null);
  readonly query = signal('');
  readonly picked = signal<PickedHost | null>(null);
  readonly hosts = signal<readonly SshHost[]>([]);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly suggestionError = signal('');
  private destination: RemoteHostInput | null = null;
  private revision = 0;

  constructor() {
    effect(onCleanup => {
      if (!this.open()) return;
      const query = this.query();
      let current = true;
      const timer = setTimeout(() => {
        void this.connection.suggestions(query).then(hosts => {
          if (current && !this.destroy.destroyed) { this.hosts.set(hosts.map(host => ({ id: host.host, name: host.host, detail: 'SSH config' }))); this.suggestionError.set(''); }
        }, () => { if (current && !this.destroy.destroyed) { this.hosts.set([]); this.suggestionError.set('Suggestions are unavailable. Enter a host directly.'); } });
      }, 150);
      onCleanup(() => { current = false; clearTimeout(timer); });
    });
    this.destroy.onDestroy(() => { ++this.revision; });
  }

  begin(from: HTMLElement): void {
    ++this.revision; this.from.set(from); this.query.set(''); this.picked.set(null); this.destination = null;
    this.saving.set(false); this.error.set(''); this.suggestionError.set(''); this.open.set(true);
  }
  cancel(): void { ++this.revision; this.open.set(false); this.saving.set(false); }
  setQuery(query: string): void { if (!this.saving()) { this.query.set(query); this.picked.set(null); this.destination = null; this.error.set(''); } }
  pick(value: string, fromConfig = false): void {
    if (this.saving()) return;
    const destination = parseSshDestination(value);
    this.error.set(destination ? '' : 'Enter an SSH alias or user@host:port with a valid port.');
    this.destination = destination;
    this.picked.set(destination ? { name: value.trim(), user: destination.user ?? 'From SSH config', port: destination.port,
      portLabel: destination.port ? undefined : 'From SSH config', auth: 'Your SSH configuration and agent', fromConfig } : null);
  }
  async connect(): Promise<void> {
    const input = this.destination;
    if (!input || this.saving()) return;
    const revision = ++this.revision;
    this.saving.set(true); this.error.set('');
    try {
      const existing = this.connection.state()?.hosts.find(host => host.host === input.host && host.user === input.user && host.port === input.port);
      const host = existing ?? await this.connection.addHost(input);
      if (this.destroy.destroyed || revision !== this.revision) return;
      this.open.set(false);
      // Preparation and sign-in now belong to the real card and challenge flow.
      await this.launcher.choose(host.id);
    } catch {
      if (!this.destroy.destroyed && revision === this.revision) this.error.set('The server could not be saved. Check your settings and try again.');
    } finally { if (!this.destroy.destroyed && revision === this.revision) this.saving.set(false); }
  }
}
