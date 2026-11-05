import type { TerminalListener } from './port-processes.js';

export interface DiscoveredTerminalService {
  readonly port: number;
  readonly host: string;
  readonly protocol: 'http' | 'https';
  readonly path: string;
}

interface ServiceHint {
  readonly protocol: 'http' | 'https';
  readonly path: string;
  readonly at: number;
  owner?: string;
}

const identity = (listener: TerminalListener) =>
  `${listener.pid}:${listener.started}`;

function hintPath(raw: string): string {
  // A path may refine a local service, never select another authority/scheme.
  // eslint-disable-next-line no-control-regex -- Untrusted terminal output.
  const unsafe = /[\x00-\x1f\x7f\\?#]/;
  if (!raw.startsWith('/') || raw.startsWith('//') || unsafe.test(raw))
    return '/';
  try {
    const url = new URL(raw, 'http://localhost');
    return url.origin === 'http://localhost' && url.pathname.length <= 2048
      ? url.pathname
      : '/';
  } catch {
    return '/';
  }
}

/** Output refines a verified socket; it never establishes that one exists. */
export class TerminalServices {
  discovery: 'pending' | 'process' | 'unavailable' = 'pending';
  private readonly hints = new Map<number, ServiceHint>();
  private listeners: readonly TerminalListener[] = [];
  private selected: number | null = null;

  hint(port: number, protocol: 'http' | 'https', path = '/'): void {
    const listener = this.listeners.find((entry) => entry.port === port);
    this.hints.delete(port);
    this.hints.set(port, {
      protocol,
      path: hintPath(path),
      at: Date.now(),
      ...(listener ? { owner: identity(listener) } : {}),
    });
    while (this.hints.size > 16) {
      const oldest = this.hints.keys().next();
      if (oldest.done) break;
      this.hints.delete(oldest.value);
    }
    if (listener) this.selected = port;
  }

  reconcile(listeners: readonly TerminalListener[] | null): void {
    this.discovery = listeners === null ? 'unavailable' : 'process';
    if (listeners === null) {
      this.listeners = [];
      return;
    }
    // Deduplicate IPv4/IPv6 and inherited descriptors. Prefer IPv4 when both are
    // owned, so existing SSH forwards remain deterministic on dual-stack hosts.
    const candidates = new Map<number, TerminalListener>();
    for (const listener of [...(listeners ?? [])].sort(
      (a, b) =>
        a.port - b.port ||
        Number(a.host.includes(':')) - Number(b.host.includes(':')) ||
        a.host.localeCompare(b.host) ||
        a.pid - b.pid,
    )) {
      if (!candidates.has(listener.port))
        candidates.set(listener.port, listener);
    }
    // Retain hinted/current services before applying the presentation bound;
    // a busy tool with many sockets must not hide its advertised application.
    const preferred = [...this.hints.keys()].reverse();
    if (this.selected !== null) preferred.push(this.selected);
    const retained = new Set(
      [
        ...new Set(
          [...preferred, ...candidates.keys()].filter((port) =>
            candidates.has(port),
          ),
        ),
      ].slice(0, 16),
    );
    const ports = new Map(
      [...candidates].filter(([port]) => retained.has(port)),
    );
    for (const [port, hint] of this.hints) {
      const listener = ports.get(port);
      if (hint.owner && (!listener || hint.owner !== identity(listener)))
        this.hints.delete(port);
      else if (listener) hint.owner = identity(listener);
      else if (Date.now() - hint.at > 30_000) this.hints.delete(port);
    }
    this.listeners = [...ports.values()];
    const hinted = [...this.hints.keys()]
      .reverse()
      .find((port) => ports.has(port));
    this.selected =
      hinted ??
      (this.selected !== null && ports.has(this.selected)
        ? this.selected
        : (this.listeners[0]?.port ?? null));
  }

  get services(): readonly DiscoveredTerminalService[] {
    return this.listeners.map((listener) => ({
      port: listener.port,
      host: listener.host,
      protocol: this.hints.get(listener.port)?.protocol ?? 'http',
      path: this.hints.get(listener.port)?.path ?? '/',
    }));
  }

  get primary(): DiscoveredTerminalService | null {
    return (
      this.services.find((service) => service.port === this.selected) ?? null
    );
  }

  clear(): void {
    this.listeners = [];
    this.hints.clear();
    this.selected = null;
  }
}
