import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { defer, from, Observable } from 'rxjs';
import { SshForward } from '../models/ssh-forward.model';
import { migrateScopedKey, serverScopedKey } from './scoped-storage';
import {
  ElectronSshForwardRuntimeState,
  getElectronSshForwardingApi,
} from '../runtime/electron-ssh-forwarding';

export interface CreateSshForwardPayload {
  name: string;
  sshHost: string;
  sshUser?: string;
  sshPort: number;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  startImmediately: boolean;
}

export interface SshForwardDefaults {
  sshHost: string;
  sshUser?: string;
  sshPort: number;
  bindAddress: string;
  remoteHost: string;
  startImmediately: boolean;
}

interface StoredSshForward {
  id: number;
  projectId: number;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string | null;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  createdAt: string;
  updatedAt: string;
}

type SshForwardStore = Record<string, StoredSshForward[]>;

// Forwards are declared per project, and project ids only mean something
// within one backend — so this is scoped per environment rather than per
// window: two windows on the same server share the same forwards.
const STORAGE_KEY_BASE = 'elevenex-ssh-forwards';
// Defaults are a user preference, and stay app-global.
const DEFAULTS_STORAGE_KEY = 'elevenex-ssh-forward-defaults';
// Marks the one-time rewrite of IPv4-only loopback targets, per environment.
const LOOPBACK_UPGRADE_KEY_BASE = 'elevenex-ssh-forwards-loopback-upgraded';

function forwardsStorageKey(): string {
  const scoped = serverScopedKey(STORAGE_KEY_BASE);
  migrateScopedKey(STORAGE_KEY_BASE, scoped);
  return scoped;
}

// A loopback IP literal pins the remote end of `-L` to one address family, so a
// forward aimed at 127.0.0.1 misses a server bound to ::1 and vice versa (a dev
// server that defaults to `localhost` on Node >= 17 binds ::1 only). `localhost`
// lets the remote sshd try every address it resolves to.
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', '[::1]']);

function preferredRemoteHost(remoteHost: string): string {
  return LOOPBACK_LITERALS.has(remoteHost.trim()) ? 'localhost' : remoteHost;
}

function loopbackUpgradeStorageKey(): string {
  return serverScopedKey(LOOPBACK_UPGRADE_KEY_BASE);
}

@Injectable({ providedIn: 'root' })
export class SshForwardsService {
  getByProject(projectId: number): Observable<SshForward[]> {
    return defer(() => from(this.loadByProject(projectId)));
  }

  getAll(): Observable<SshForward[]> {
    return defer(() => from(this.loadAll()));
  }

  getAllOnce(): Promise<SshForward[]> {
    return firstValueFrom(this.getAll());
  }

  create(projectId: number, payload: CreateSshForwardPayload): Observable<SshForward> {
    return defer(() => from(this.createInternal(projectId, payload)));
  }

  start(id: number): Observable<SshForward> {
    return defer(() => from(this.startInternal(id)));
  }

  stop(id: number): Observable<SshForward> {
    return defer(() => from(this.stopInternal(id)));
  }

  remove(id: number): Observable<SshForward> {
    return defer(() => from(this.removeInternal(id)));
  }

  async isSupported(): Promise<boolean> {
    const api = getElectronSshForwardingApi();
    if (!api) {
      return false;
    }

    try {
      return await api.isSupported();
    } catch {
      return false;
    }
  }

  getLastDefaults(): SshForwardDefaults | null {
    try {
      const raw = localStorage.getItem(DEFAULTS_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<SshForwardDefaults>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.sshHost !== 'string') {
        return null;
      }

      return {
        sshHost: parsed.sshHost,
        sshUser: parsed.sshUser,
        sshPort: Number(parsed.sshPort) || 22,
        bindAddress: parsed.bindAddress || '127.0.0.1',
        remoteHost: parsed.remoteHost || 'localhost',
        startImmediately: parsed.startImmediately ?? true,
      };
    } catch {
      return null;
    }
  }

  private async loadByProject(projectId: number): Promise<SshForward[]> {
    const entries = this.readStore()[projectId] ?? [];
    return Promise.all(entries.map(entry => this.enrich(entry)));
  }

  private async loadAll(): Promise<SshForward[]> {
    const entries = Object.values(this.readStore()).flat();
    return Promise.all(entries.map(entry => this.enrich(entry)));
  }

  private async createInternal(projectId: number, payload: CreateSshForwardPayload): Promise<SshForward> {
    this.assertValidPayload(payload);

    const store = this.readStore();
    const entries = store[projectId] ?? [];
    const now = new Date().toISOString();
    const stored: StoredSshForward = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      projectId,
      name: payload.name.trim(),
      sshHost: payload.sshHost.trim(),
      sshUser: payload.sshUser?.trim() || null,
      sshPort: payload.sshPort,
      bindAddress: payload.bindAddress.trim(),
      localPort: payload.localPort,
      remoteHost: payload.remoteHost.trim(),
      remotePort: payload.remotePort,
      createdAt: now,
      updatedAt: now,
    };

    store[projectId] = [stored, ...entries];
    this.writeStore(store);
    this.writeDefaults(payload);

    if (payload.startImmediately && await this.isSupported()) {
      return this.startStored(stored);
    }

    return this.enrich(stored);
  }

  private async startInternal(id: number): Promise<SshForward> {
    const stored = this.findStoredById(id);
    return this.startStored(stored);
  }

  private async startStored(stored: StoredSshForward): Promise<SshForward> {
    const api = getElectronSshForwardingApi();
    if (!api || !(await this.isSupported())) {
      throw new Error('SSH forwarding is only available in the Electron app.');
    }

    const runtime = await api.start({
      id: stored.id,
      sshHost: stored.sshHost,
      sshUser: stored.sshUser,
      sshPort: stored.sshPort,
      bindAddress: stored.bindAddress,
      localPort: stored.localPort,
      remoteHost: stored.remoteHost,
      remotePort: stored.remotePort,
    });

    return this.toViewModel(stored, runtime);
  }

  private async stopInternal(id: number): Promise<SshForward> {
    const stored = this.findStoredById(id);
    const api = getElectronSshForwardingApi();
    const runtime = api && await this.isSupported() ? await api.stop(id) : null;
    return this.toViewModel(stored, runtime);
  }

  private async removeInternal(id: number): Promise<SshForward> {
    const store = this.readStore();
    const stored = this.findStoredById(id, store);
    const entries = store[stored.projectId] ?? [];
    const api = getElectronSshForwardingApi();

    if (api && await this.isSupported()) {
      await api.stop(id);
    }

    store[stored.projectId] = entries.filter(entry => entry.id !== id);
    this.writeStore(store);
    return this.toViewModel(stored, null);
  }

  private async enrich(stored: StoredSshForward): Promise<SshForward> {
    const api = getElectronSshForwardingApi();
    const runtime = api && await this.isSupported() ? await api.getState(stored.id) : null;
    return this.toViewModel(stored, runtime);
  }

  private toViewModel(
    stored: StoredSshForward,
    runtime: ElectronSshForwardRuntimeState | null,
  ): SshForward {
    return {
      ...stored,
      status: runtime?.status ?? 'inactive',
      pid: runtime?.pid ?? null,
      startedAt: runtime?.startedAt ?? null,
      stoppedAt: runtime?.stoppedAt ?? null,
      lastError: runtime?.lastError ?? null,
      debugDetails: runtime?.debugDetails ?? null,
      destinationLabel: `${stored.bindAddress}:${stored.localPort} -> ${stored.remoteHost}:${stored.remotePort}`,
      connectionLabel: stored.sshUser
        ? `${stored.sshUser}@${stored.sshHost}:${stored.sshPort}`
        : `${stored.sshHost}:${stored.sshPort}`,
    };
  }

  private assertValidPayload(payload: CreateSshForwardPayload) {
    if (!payload.name.trim()) throw new Error('Name is required');
    if (!payload.sshHost.trim()) throw new Error('SSH host is required');
    if (!payload.bindAddress.trim()) throw new Error('Bind address is required');
    if (!payload.remoteHost.trim()) throw new Error('Remote host is required');

    for (const port of [payload.sshPort, payload.localPort, payload.remotePort]) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Ports must be between 1 and 65535');
      }
    }
  }

  private findStoredById(id: number, store = this.readStore()): StoredSshForward {
    for (const entries of Object.values(store)) {
      const match = entries.find(entry => entry.id === id);
      if (match) {
        return match;
      }
    }

    throw new Error(`SSH forward ${id} was not found`);
  }

  private readStore(): SshForwardStore {
    try {
      const raw = localStorage.getItem(forwardsStorageKey());
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as SshForwardStore;
      if (typeof parsed !== 'object' || parsed === null) {
        return {};
      }
      return this.upgradeLoopbackRemoteHostsOnce(parsed);
    } catch {
      return {};
    }
  }

  // Forwards created before `localhost` became the default kept an IPv4-only
  // target, so they are rewritten in place rather than left silently unable to
  // reach an IPv6 listener. Runs once per environment: a remote host typed by
  // hand afterwards is a deliberate choice and stays as it is.
  private upgradeLoopbackRemoteHostsOnce(store: SshForwardStore): SshForwardStore {
    if (localStorage.getItem(loopbackUpgradeStorageKey()) === 'done') {
      return store;
    }

    let changed = false;
    for (const entries of Object.values(store)) {
      for (const entry of entries ?? []) {
        const upgraded = preferredRemoteHost(`${entry.remoteHost ?? ''}`);
        if (upgraded !== entry.remoteHost) {
          entry.remoteHost = upgraded;
          changed = true;
        }
      }
    }

    if (changed) {
      this.writeStore(store);
    }
    localStorage.setItem(loopbackUpgradeStorageKey(), 'done');

    return store;
  }

  private writeStore(store: SshForwardStore) {
    localStorage.setItem(forwardsStorageKey(), JSON.stringify(store));
  }

  private writeDefaults(payload: CreateSshForwardPayload) {
    const defaults: SshForwardDefaults = {
      sshHost: payload.sshHost.trim(),
      sshUser: payload.sshUser?.trim() || undefined,
      sshPort: payload.sshPort,
      bindAddress: payload.bindAddress.trim(),
      remoteHost: payload.remoteHost.trim(),
      startImmediately: payload.startImmediately,
    };
    localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  }
}
