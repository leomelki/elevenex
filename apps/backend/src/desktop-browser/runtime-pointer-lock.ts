import { randomUUID } from 'node:crypto';
import type { CDPSession, Frame, Page } from 'playwright-core';
import {
  PointerLockTarget,
  type PointerLockContext,
} from './runtime-pointer-lock-target.js';

const RECONCILE_INTERVAL = 1000;
const RECONCILE_DEADLINE = 250;

/** Tab-owned lock identity. Motion reads only this state, never a page evaluator. */
export class RuntimePointerLock {
  private page?: Page;
  private owner?: PointerLockContext;
  private readonly targets = new Map<Frame, PointerLockTarget>();
  private readonly attaching = new Map<Frame, Promise<void>>();
  private readonly exits = new Map<PointerLockContext, Promise<void>>();
  private readonly blocked = new Set<PointerLockContext>();
  private readonly world = 'elevenex-pointer-lock-' + randomUUID();
  private readonly binding =
    '__elevenexPointerLock_' + randomUUID().replaceAll('-', '');
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private epochValue = 1;

  constructor(
    private readonly changed: () => void,
    private readonly permitted: () => boolean,
  ) {}

  get locked(): boolean {
    return this.owner !== undefined;
  }
  get epoch(): number {
    return this.epochValue;
  }

  assert(epoch: number): void {
    if (!this.owner || this.epoch !== epoch || !this.permitted())
      throw new Error('Pointer lock ended');
  }

  async settled(): Promise<void> {
    await Promise.all(this.exits.values());
    if (this.blocked.size)
      throw new Error('Pointer lock release is unavailable');
  }

  async attach(page: Page, cdp: CDPSession): Promise<void> {
    await this.detach();
    this.page = page;
    const revision = ++this.revision;
    const main = this.target(cdp, false, page.mainFrame());
    this.targets.set(page.mainFrame(), main);
    page.on('frameattached', this.frameChanged);
    page.on('framenavigated', this.frameChanged);
    page.on('framedetached', this.frameRemoved);
    await main.start();
    if (this.page !== page || revision !== this.revision) return;
    await Promise.all(
      page
        .frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) => this.attachFrame(frame)),
    );
  }

  private readonly frameChanged = (frame: Frame) => {
    void this.attachFrame(frame);
  };
  private readonly frameRemoved = (frame: Frame) => {
    const target = this.targets.get(frame);
    this.targets.delete(frame);
    if (target) void target.destroy();
  };

  private attachFrame(frame: Frame): Promise<void> {
    if (
      !this.page ||
      frame.page() !== this.page ||
      frame === this.page.mainFrame() ||
      frame.isDetached() ||
      this.targets.has(frame)
    )
      return Promise.resolve();
    const pending = this.attaching.get(frame);
    if (pending) return pending;
    const page = this.page,
      revision = this.revision;
    const operation = (async () => {
      let cdp: CDPSession;
      try {
        cdp = await page.context().newCDPSession(frame);
      } catch {
        return;
      } // Local frames already belong to their parent's target.
      if (
        this.page !== page ||
        this.revision !== revision ||
        frame.isDetached()
      ) {
        await cdp.detach().catch(() => undefined);
        return;
      }
      const target = this.target(cdp, true, frame);
      this.targets.set(frame, target);
      try {
        await target.start();
      } catch {
        if (this.targets.get(frame) === target) this.targets.delete(frame);
        await target.destroy();
      }
    })().finally(() => {
      if (this.attaching.get(frame) === operation) this.attaching.delete(frame);
    });
    this.attaching.set(frame, operation);
    return operation;
  }

  private target(
    cdp: CDPSession,
    owned: boolean,
    frame: Frame,
  ): PointerLockTarget {
    const target = new PointerLockTarget(
      cdp,
      owned,
      this.world,
      this.binding,
      (context, locked, change) => this.report(context, locked, change),
      (context) => {
        this.blocked.delete(context);
        this.exits.delete(context);
        if (this.owner === context) this.clear();
      },
      () => {
        if (this.targets.get(frame) !== target) return;
        this.targets.delete(frame);
        void target.destroy();
        // Process swaps can retain the Playwright Frame identity.
        if (owned && this.page && !frame.isDetached()) {
          // A close during startup must retry after the old attachment has
          // removed its single-flight entry, rather than joining that old work.
          void (this.attaching.get(frame) ?? Promise.resolve()).then(() =>
            this.frameChanged(frame),
          );
        }
      },
    );
    return target;
  }

  private report(
    context: PointerLockContext,
    locked: boolean,
    change: boolean,
  ): void {
    context.locked = locked;
    if (!locked) {
      // An exit must finish before this context can publish another grant.
      // Otherwise a delayed native exit could release that newer acquisition.
      if (!this.exits.has(context)) {
        context.revoked = false;
        this.blocked.delete(context);
      }
      if (this.owner === context) this.clear();
      return;
    }
    if (context.revoked || this.exits.has(context) || !this.permitted()) {
      this.requestExit(context);
      return;
    }
    if (this.owner === context && !change) return;
    // Even two trusted change events that both observe `true` define a new
    // lease: JS can release/reacquire before either notification is serviced.
    if (this.owner && this.owner !== context) this.owner.revoked = true;
    this.owner = context;
    this.epochValue++;
    this.schedule();
    this.changed();
  }

  /** Revoke admission synchronously, then request native exit only in the owner. */
  unlock(expectedEpoch?: number): void {
    if (expectedEpoch !== undefined && expectedEpoch !== this.epoch) return;
    const owner = this.owner;
    if (!owner) return;
    owner.revoked = true;
    this.clear();
    this.requestExit(owner);
  }

  private requestExit(context: PointerLockContext): void {
    context.revoked = true;
    this.blocked.add(context);
    if (this.exits.has(context)) return;
    const operation = (async () => {
      try {
        // One further exit can clean up a native reacquisition observed while
        // the first exit completed. A noncooperating page cannot create an
        // unbounded evaluator loop; unresolved state stays gated instead.
        for (let attempt = 0; attempt < 2; attempt++) {
          await context.target.exit(context);
          if (!context.locked || !context.target.active(context) || !this.page)
            break;
        }
        if (!context.locked || !context.target.active(context)) {
          context.revoked = false;
          this.blocked.delete(context);
        }
      } catch {
        // Keep ordinary pointer input gated if a live context's native exit
        // is uncertain. A later real unlock or context removal clears it.
        if (!context.target.active(context)) this.blocked.delete(context);
      }
    })().finally(() => {
      if (this.exits.get(context) === operation) this.exits.delete(context);
    });
    this.exits.set(context, operation);
  }

  private clear(): void {
    if (!this.owner) return;
    this.owner = undefined;
    this.epochValue++;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.changed();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    const owner = this.owner;
    if (!owner) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const epoch = this.epoch;
      this.deadline = setTimeout(() => {
        this.deadline = undefined;
        if (this.owner === owner) this.unlock(epoch);
      }, RECONCILE_DEADLINE);
      // The pending read stays single-flight even after its deadline. No
      // timeout loop can accumulate work against a stalled execution context.
      void owner.target.read(owner).then(
        () => {
          if (this.owner === owner && this.epoch === epoch) this.schedule();
        },
        () => {
          if (this.owner === owner) this.unlock(epoch);
        },
      );
    }, RECONCILE_INTERVAL);
  }

  async detach(): Promise<void> {
    this.revision++;
    this.unlock();
    const page = this.page;
    this.page = undefined;
    page?.off('frameattached', this.frameChanged);
    page?.off('framenavigated', this.frameChanged);
    page?.off('framedetached', this.frameRemoved);
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(targets.map((target) => target.destroy()));
    // In-progress attachments check the page/revision and detach themselves.
    this.attaching.clear();
  }
}
