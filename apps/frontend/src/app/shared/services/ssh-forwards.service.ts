import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { defer, from, Observable } from 'rxjs';
import { SshForward } from '../models/ssh-forward.model';
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

const STORAGE_KEY = 'elevenex-ssh-forwards';
const DEFAULTS_STORAGE_KEY = 'elevenex-ssh-forward-defaults';

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
        remoteHost: parsed.remoteHost || '127.0.0.1',
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
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as SshForwardStore;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeStore(store: SshForwardStore) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
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
