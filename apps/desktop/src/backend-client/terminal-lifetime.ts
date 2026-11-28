import { randomUUID } from 'node:crypto';
import { requestBackendJson, type BackendEndpoint } from './transport';

/** App-owned shells are closed before engines and SSH transports are released. */
export class TerminalLifetime {
  readonly owner = randomUUID();
  private readonly endpoints = new Map<string, BackendEndpoint>();
  private closing?: Promise<void>;

  track(endpoint: BackendEndpoint, engine = endpoint.url): void {
    if (this.closing) throw new Error('Terminal application is closing');
    if (!this.endpoints.has(engine) && this.endpoints.size >= 128)
      throw new Error('Terminal engine limit reached');
    this.endpoints.set(engine, endpoint);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.endpoints.values()].map(async endpoint => {
        const reply = await requestBackendJson(endpoint, {
          path: `/api/desktop-workspace/terminal-owners/${this.owner}`,
          method: 'DELETE', limit: 1024,
        }, AbortSignal.timeout(30000));
        if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true)
          throw new Error('Invalid terminal cleanup reply');
      }));
      this.endpoints.clear();
      if (results.some(result => result.status === 'rejected'))
        console.error('Some terminal engines could not be reached for app-close cleanup');
    })();
    return this.closing;
  }
}
