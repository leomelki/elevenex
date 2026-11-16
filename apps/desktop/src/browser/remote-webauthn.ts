import type { BrowserWindow } from 'electron';
import type { BrowserWebAuthnRequest, BrowserWebAuthnResult } from '@elevenex/shared';
import type { WebAuthnBroker } from './webauthn-broker';
import { webAuthnOptions } from './webauthn-validation';

/** One task/viewer lifetime. State drives cancellation, never ceremony replay. */
export class RemoteWebAuthn {
  private active?: { id: string; controller: AbortController };
  private consumed = new Set<string>();
  constructor(
    private readonly parent: BrowserWindow,
    private readonly broker: WebAuthnBroker,
    private readonly current: () => boolean,
    private readonly request: (body: unknown) => Promise<unknown>,
  ) {}
  sync(pending?: BrowserWebAuthnRequest): void {
    if (!this.current() || this.active?.id !== pending?.id) this.cancel();
    if (!pending || this.active || this.consumed.has(pending.id) || !this.current()) return;
    const active = { id: pending.id, controller: new AbortController() };
    this.active = active;
    this.consumed.add(pending.id);
    // Requests expire after two minutes and only one exists at a time. Retain a
    // bounded tombstone window so repeated snapshots cannot reopen a native UI.
    if (this.consumed.size > 64) this.consumed.delete(this.consumed.values().next().value!);
    void this.run(pending, active).finally(() => { if (this.active === active) this.active = undefined; });
  }
  private async run(pending: BrowserWebAuthnRequest, active: { id: string; controller: AbortController }): Promise<void> {
    const valid = () => this.active === active && !active.controller.signal.aborted && this.current();
    let result: BrowserWebAuthnResult;
    try {
      const options = webAuthnOptions(await this.request({ requestId: pending.id }), pending);
      if (!valid()) return;
      result = await this.broker.run(this.parent, options, active.controller.signal);
    } catch {
      result = { error: { name: 'NotAllowedError', message: 'Authentication unavailable.' } };
    }
    if (valid()) await this.request({ requestId: pending.id, result }).catch(() => undefined);
  }
  cancel(): void { this.active?.controller.abort(); this.active = undefined; }
}
