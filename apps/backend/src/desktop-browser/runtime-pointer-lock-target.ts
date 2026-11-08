import type { CDPSession } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { pointerLockObserver } from './runtime-pointer-lock-observer.js';

export interface PointerLockContext {
  readonly target: PointerLockTarget;
  readonly id: number;
  readonly frameId: string;
  readonly uniqueId: string;
  readonly ticket: string;
  sequence: number;
  locked: boolean;
  revoked: boolean;
  reading?: Promise<void>;
  exiting?: Promise<void>;
}

/** One renderer target, including its local child frames. OOPIFs have their own target. */
export class PointerLockTarget {
  private readonly contexts = new Map<number, PointerLockContext>();
  private script?: string;
  private disposed = false;
  private bindingReady = false;

  constructor(
    readonly cdp: CDPSession,
    private readonly owned: boolean,
    private readonly world: string,
    private readonly binding: string,
    private readonly report: (
      context: PointerLockContext,
      locked: boolean,
      change: boolean,
    ) => void,
    private readonly removed: (context: PointerLockContext) => void,
    private readonly closed: () => void,
  ) {}

  private readonly created = ({
    context,
  }: {
    context: { id: number; uniqueId: string; name: string; auxData?: unknown };
  }) => {
    const aux: unknown = context.auxData;
    if (
      this.disposed ||
      context.name !== this.world ||
      !aux ||
      typeof aux !== 'object' ||
      !('frameId' in aux) ||
      typeof aux.frameId !== 'string'
    )
      return;
    this.remove(context.id);
    const registered: PointerLockContext = {
      target: this,
      id: context.id,
      uniqueId: context.uniqueId,
      frameId: aux.frameId,
      ticket: randomUUID(),
      sequence: 0,
      locked: false,
      revoked: false,
    };
    this.contexts.set(context.id, registered);
    if (this.bindingReady) this.authorize(registered);
  };
  private readonly destroyed = ({
    executionContextId,
    executionContextUniqueId,
  }: {
    executionContextId: number;
    executionContextUniqueId: string;
  }) => {
    if (
      this.contexts.get(executionContextId)?.uniqueId ===
      executionContextUniqueId
    )
      this.remove(executionContextId);
  };
  private readonly cleared = () => {
    for (const id of this.contexts.keys()) this.remove(id);
  };
  private readonly detached = ({ frameId }: { frameId: string }) => {
    for (const context of this.contexts.values())
      if (context.frameId === frameId) this.remove(context.id);
  };
  private readonly opened = ({ frame }: { frame: { id: string } }) => {
    for (const context of [...this.contexts.values()]) {
      if (context.frameId !== frame.id) continue;
      this.remove(context.id);
      const replacement: PointerLockContext = {
        ...context,
        ticket: randomUUID(),
        sequence: 0,
        locked: false,
        revoked: false,
        reading: undefined,
        exiting: undefined,
      };
      this.contexts.set(replacement.id, replacement);
      this.authorize(replacement, true);
    }
  };
  private readonly called = ({
    name,
    payload,
    executionContextId,
  }: {
    name: string;
    payload: string;
    executionContextId: number;
  }) => {
    const context = this.contexts.get(executionContextId);
    if (
      this.disposed ||
      name !== this.binding ||
      !context ||
      payload.length > 192
    )
      return;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      !('locked' in value) ||
      typeof value.locked !== 'boolean' ||
      !('change' in value) ||
      typeof value.change !== 'boolean' ||
      !('sequence' in value) ||
      typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence <= context.sequence ||
      !('ticket' in value) ||
      value.ticket !== context.ticket
    )
      return;
    context.sequence = value.sequence;
    this.report(context, value.locked, value.change);
  };
  private readonly disconnected = () => {
    this.cleared();
    this.closed();
  };

  async start(): Promise<void> {
    this.cdp.on('Runtime.executionContextCreated', this.created);
    this.cdp.on('Runtime.executionContextDestroyed', this.destroyed);
    this.cdp.on('Runtime.executionContextsCleared', this.cleared);
    this.cdp.on('Runtime.bindingCalled', this.called);
    this.cdp.on('Page.frameDetached', this.detached);
    this.cdp.on('Page.documentOpened', this.opened);
    this.cdp.on('close', this.disconnected);
    await this.cdp.send('Runtime.enable');
    this.assertActive();
    await this.cdp.send('Runtime.addBinding', {
      name: this.binding,
      executionContextName: this.world,
    });
    this.assertActive();
    this.bindingReady = true;
    for (const context of this.contexts.values()) this.authorize(context);
    await this.cdp.send('Page.enable');
    this.assertActive();
    const { identifier } = await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(${pointerLockObserver.toString()})(${JSON.stringify(this.binding)})`,
        worldName: this.world,
        runImmediately: true,
      },
    );
    this.script = identifier;
    if (this.disposed) {
      await this.cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        .catch(() => undefined);
      throw new Error('Pointer lock observation stopped');
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Pointer lock observation stopped');
  }

  active(context: PointerLockContext): boolean {
    return !this.disposed && this.contexts.get(context.id) === context;
  }

  private authorize(
    context: PointerLockContext,
    replaceDocument = false,
  ): void {
    // Context IDs can be reused after a renderer process swap. Only a ticket
    // installed through uniqueContextId may authenticate subsequent callbacks.
    void this.evaluate(
      context,
      (replaceDocument
        ? `globalThis[${JSON.stringify(this.binding + 'Stop')}]?.();`
        : '') +
        `(${pointerLockObserver.toString()})(${JSON.stringify(this.binding)});` +
        `globalThis[${JSON.stringify(this.binding + 'Authorize')}](${JSON.stringify(context.ticket)})`,
    ).catch(() => {
      if (this.contexts.get(context.id) === context) this.remove(context.id);
    });
  }

  read(context: PointerLockContext): Promise<void> {
    return (context.reading ??= this.evaluate(
      context,
      `globalThis[${JSON.stringify(this.binding + 'Read')}](${JSON.stringify(context.ticket)})`,
    ).finally(() => {
      context.reading = undefined;
    }));
  }

  exit(context: PointerLockContext): Promise<void> {
    return (context.exiting ??= this.evaluate(
      context,
      `globalThis[${JSON.stringify(this.binding + 'Exit')}](${JSON.stringify(context.ticket)})`,
    ).finally(() => {
      context.exiting = undefined;
    }));
  }

  private async evaluate(
    context: PointerLockContext,
    expression: string,
  ): Promise<void> {
    if (this.disposed || this.contexts.get(context.id) !== context) return;
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      uniqueContextId: context.uniqueId,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error('Pointer lock observation unavailable');
  }

  private remove(id: number): void {
    const context = this.contexts.get(id);
    if (!context) return;
    this.contexts.delete(id);
    this.removed(context);
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cdp.off('Runtime.executionContextCreated', this.created);
    this.cdp.off('Runtime.executionContextDestroyed', this.destroyed);
    this.cdp.off('Runtime.executionContextsCleared', this.cleared);
    this.cdp.off('Runtime.bindingCalled', this.called);
    this.cdp.off('Page.frameDetached', this.detached);
    this.cdp.off('Page.documentOpened', this.opened);
    this.cdp.off('close', this.disconnected);
    for (const context of this.contexts.values()) {
      // A busy document cannot hold teardown. The page owns any outstanding
      // evaluations and is closed by the tab; no new observations can publish.
      void this.cdp
        .send('Runtime.evaluate', {
          uniqueContextId: context.uniqueId,
          expression: `globalThis[${JSON.stringify(this.binding + 'Stop')}]?.(${JSON.stringify(context.ticket)})`,
        })
        .catch(() => undefined);
    }
    this.cleared();
    if (this.script)
      await this.cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: this.script,
        })
        .catch(() => undefined);
    await this.cdp
      .send('Runtime.removeBinding', { name: this.binding })
      .catch(() => undefined);
    if (this.owned) await this.cdp.detach().catch(() => undefined);
  }
}
