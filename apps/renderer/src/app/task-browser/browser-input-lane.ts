import type {
  TaskBrowserStreamInput,
  TaskBrowserStreamEvent,
} from "@elevenex/shared";

/** A bounded human-input lane. Authority changes drop queued input; failed writes are never replayed. */
export class BrowserInputLane {
  private generation = 0;
  private driver: "you" | "agent" | "needs" = "you";
  private enabled = false;
  private expectedTakeover = 0;
  private inFlight = 0;
  private clipboardPending = false;
  private revision = 0;
  private scheduled = false;
  private disposed = false;
  private uncertain = false;
  private queuedTextUnits = 0;
  private unlockPending?: Extract<TaskBrowserStreamEvent, { kind: 'pointer-unlock' }>;
  private unlocking = false;
  private pointerEpoch?: number;
  private motionRevision = 0;
  get needsInteraction(): boolean {
    return this.uncertain;
  }
  resume(): void {
    if (!this.disposed && this.uncertain) {
      this.revision++;
      this.uncertain = false;
      this.clearQueue();
    }
  }
  private queue: TaskBrowserStreamEvent[] = [];
  constructor(
    private readonly dispatch: (
      generation: number,
      input: TaskBrowserStreamInput,
    ) => Promise<number>,
    private readonly interrupted: () => void,
    private readonly windowSize: () => number = () => 1,
    private readonly release?: (generation: number) => Promise<unknown>,
  ) {}
  authority(
    generation: number,
    driver: "you" | "agent" | "needs",
    enabled: boolean,
    pointerEpoch?: number,
  ): void {
    if (pointerEpoch !== this.pointerEpoch) {
      this.pointerEpoch = pointerEpoch;
      this.motionRevision++;
      this.queue = this.queue.filter(event => event.kind !== 'pointer-relative' || event.pointerLockEpoch === pointerEpoch);
    }
    if (
      generation > this.generation &&
      !(generation === this.expectedTakeover && driver !== "agent")
    ) {
      this.clearQueue();
      this.revision++;
    }
    if (!enabled && this.enabled) {
      this.clearQueue();
      this.revision++;
    }
    this.generation = Math.max(this.generation, generation);
    this.driver = driver;
    this.enabled = enabled;
  }
  send(input: TaskBrowserStreamEvent): void {
    if (this.disposed || !this.enabled) return;
    if (input.kind === "release") return;
    if (input.kind === 'pointer-unlock') {
      this.motionRevision++;
      this.queue = this.queue.filter(event => event.kind !== 'pointer-relative' ||
        (input.pointerLockEpoch !== undefined && event.pointerLockEpoch !== input.pointerLockEpoch));
      this.unlockPending = input;
      this.flushUnlock();
      return;
    }
    if (this.uncertain) {
      if (input.kind !== "pointer" || input.type !== "down") return;
      this.resume();
    }
    const previous = this.queue.at(-1);
    const textUnits =
      this.queuedTextUnits +
      this.textUnits(input) -
      (input.kind === "composition" && previous?.kind === "composition"
        ? this.textUnits(previous)
        : 0);
    if (textUnits > 65536) {
      this.interrupt();
      return;
    }
    if (
      input.kind === "pointer" &&
      input.type === "move" &&
      previous?.kind === "pointer" &&
      previous.type === "move" &&
      previous.buttons === input.buttons &&
      previous.modifiers === input.modifiers
    )
      this.queue[this.queue.length - 1] = input;
    else if (input.kind === 'pointer-relative' && previous?.kind === 'pointer-relative' && previous.pointerLockEpoch === input.pointerLockEpoch && previous.buttons === input.buttons && previous.modifiers === input.modifiers && Math.abs(previous.deltaX + input.deltaX) <= 10000 && Math.abs(previous.deltaY + input.deltaY) <= 10000)
      this.queue[this.queue.length - 1] = { ...input, deltaX: previous.deltaX + input.deltaX, deltaY: previous.deltaY + input.deltaY };
    else if (input.kind === "composition" && previous?.kind === "composition")
      this.queue[this.queue.length - 1] = input;
    else if (
      input.kind === "wheel" &&
      previous?.kind === "wheel" &&
      previous.x === input.x &&
      previous.y === input.y &&
      previous.modifiers === input.modifiers
    )
      this.queue[this.queue.length - 1] = {
        ...input,
        deltaX: Math.max(
          -10000,
          Math.min(10000, input.deltaX + previous.deltaX),
        ),
        deltaY: Math.max(
          -10000,
          Math.min(10000, input.deltaY + previous.deltaY),
        ),
      };
    // Keep a fast burst during a long jitter pause, bounded by both event count
    // and text memory. This buffer contains only work not yet dispatched.
    else if (this.queue.length < 512) this.queue.push(input);
    else {
      this.interrupt();
      return;
    }
    this.queuedTextUnits = textUnits;
    if (this.windowSize() === 1) this.flush();
    else this.schedule();
  }
  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }
  private flushUnlock(): void {
    if (!this.unlockPending || this.unlocking || !this.enabled || this.disposed) return;
    const input = this.unlockPending, generation = this.generation, revision = this.revision, motion = this.motionRevision;
    this.unlockPending = undefined;
    this.unlocking = true;
    // Reserve one cleanup request beyond the normal four-credit window. Escape
    // must revoke host admission even while movement receipts are stalled.
    void this.dispatch(generation, input).then(accepted => {
      if (accepted !== generation && revision === this.revision && motion === this.motionRevision && !this.disposed) this.interrupt();
    }).catch(() => {
      if (revision === this.revision && motion === this.motionRevision && !this.disposed) this.interrupt();
    }).finally(() => { this.unlocking = false; this.flushUnlock(); });
  }
  private flush(): void {
    if (
      this.disposed ||
      this.uncertain ||
      !this.enabled ||
      this.clipboardPending
    )
      return;
    // A small ordered window hides RTT without growing an outbox. Agent takeover
    // and clipboard remain barriers; the host serializes complete input batches.
    while (
      this.queue.length &&
      this.inFlight < Math.max(1, Math.min(4, this.windowSize())) &&
      !(this.driver === "agent" && this.inFlight)
    ) {
      if (this.queue[0]?.kind === "clipboard" && this.inFlight) return;
      const generation = this.generation,
        first = this.queue[0]!,
        clipboardIndex = this.queue.findIndex(
          (event) => event.kind === "clipboard",
        );
      let count =
        first.kind === "clipboard"
          ? 1
          : Math.min(
              32,
              clipboardIndex < 0 ? this.queue.length : clipboardIndex,
            );
      let size = 0;
      for (let index = 0; index < count; index++) {
        const event = this.queue[index]!;
        size += this.textUnits(event);
        if (size > 65536) {
          count = Math.max(1, index);
          break;
        }
      }
      const events = this.queue.splice(0, count);
      this.queuedTextUnits -= events.reduce(
        (sum, event) => sum + this.textUnits(event),
        0,
      );
      const input: TaskBrowserStreamInput =
        events.length === 1 ? events[0]! : { kind: "batch", events };
      this.expectedTakeover = this.driver === "agent" ? generation + 1 : 0;
      const takeover = this.expectedTakeover,
        revision = this.revision;
      const motion = events.every(event => event.kind === 'pointer-relative') ? this.motionRevision : undefined;
      const clipboard = first.kind === "clipboard";
      this.inFlight++;
      this.clipboardPending = clipboard;
      void this.dispatch(generation, input)
        .then((accepted) => {
          if (!this.disposed && revision === this.revision && (motion === undefined || motion === this.motionRevision)) {
            if (accepted !== generation && accepted !== takeover) {
              this.interrupt();
            }
            this.generation = Math.max(this.generation, accepted);
            if (takeover && accepted === takeover) this.driver = "you";
          }
        })
        .catch(() => {
          if (!this.disposed && revision === this.revision && (motion === undefined || motion === this.motionRevision)) {
            this.interrupt();
          }
        })
        .finally(() => {
          this.inFlight--;
          if (clipboard) this.clipboardPending = false;
          if (takeover === this.expectedTakeover) this.expectedTakeover = 0;
          this.schedule();
        });
      if (clipboard) return;
    }
  }
  private interrupt(): void {
    this.clearQueue();
    this.revision++;
    this.uncertain = true;
    // Releasing held human state is cleanup, never a retry of an uncertain write.
    void this.release?.(this.generation).catch(() => undefined);
    this.interrupted();
  }
  private textUnits(input: TaskBrowserStreamEvent): number {
    return input.kind === "key" ||
      input.kind === "text" ||
      input.kind === "composition"
      ? (input.text?.length ?? 0)
      : 0;
  }
  private clearQueue(): void {
    this.queue = [];
    this.queuedTextUnits = 0;
    this.unlockPending = undefined;
  }
  reset(): void {
    this.revision++;
    this.generation = 0;
    this.driver = "you";
    this.expectedTakeover = 0;
    this.enabled = false;
    this.uncertain = false;
    this.pointerEpoch = undefined;
    this.motionRevision++;
    this.clearQueue();
  }
  cancel(): void {
    this.clearQueue();
  }
  destroy(): void {
    this.disposed = true;
    this.clearQueue();
  }
}
