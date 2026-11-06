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
  private sending = false;
  private disposed = false;
  private uncertain = false;
  get needsInteraction(): boolean {
    return this.uncertain;
  }
  resume(): void {
    if (!this.disposed) {
      this.uncertain = false;
      this.queue = [];
    }
  }
  private queue: TaskBrowserStreamEvent[] = [];
  constructor(
    private readonly dispatch: (
      generation: number,
      input: TaskBrowserStreamInput,
    ) => Promise<number>,
    private readonly interrupted: () => void,
  ) {}
  authority(
    generation: number,
    driver: "you" | "agent" | "needs",
    enabled: boolean,
  ): void {
    if (
      generation > this.generation &&
      !(generation === this.expectedTakeover && driver !== "agent")
    )
      this.queue = [];
    if (!enabled) this.queue = [];
    this.generation = Math.max(this.generation, generation);
    this.driver = driver;
    this.enabled = enabled;
  }
  send(input: TaskBrowserStreamEvent): void {
    if (this.disposed || !this.enabled) return;
    if (this.uncertain) {
      if (input.kind !== "pointer" || input.type !== "down") return;
      this.resume();
    }
    const previous = this.queue.at(-1);
    if (
      input.kind === "pointer" &&
      input.type === "move" &&
      previous?.kind === "pointer" &&
      previous.type === "move" &&
      previous.buttons === input.buttons &&
      previous.modifiers === input.modifiers
    )
      this.queue[this.queue.length - 1] = input;
    else if (input.kind === "composition" && previous?.kind === "composition")
      this.queue[this.queue.length - 1] = input;
    else if (input.kind === "wheel" && previous?.kind === "wheel" &&
      previous.x === input.x && previous.y === input.y &&
      previous.modifiers === input.modifiers)
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
    else if (this.queue.length < 128) this.queue.push(input);
    else {
      this.queue = [];
      this.uncertain = true;
      this.interrupted();
      return;
    }
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.sending || this.disposed || !this.enabled || !this.queue.length)
      return;
    this.sending = true;
    const generation = this.generation,
      first = this.queue[0]!,
      clipboard = this.queue.findIndex((event) => event.kind === "clipboard");
    let count =
      first.kind === "clipboard"
        ? 1
        : Math.min(32, clipboard < 0 ? this.queue.length : clipboard);
    let size = 0;
    for (let index = 0; index < count; index++) {
      const event = this.queue[index]!;
      size +=
        event.kind === "text" || event.kind === "composition"
          ? event.text.length
          : 0;
      if (size > 65536) {
        count = Math.max(1, index);
        break;
      }
    }
    const events = this.queue.splice(0, count);
    const input: TaskBrowserStreamInput =
      events.length === 1 ? events[0]! : { kind: "batch", events };
    this.expectedTakeover = this.driver === "agent" ? generation + 1 : 0;
    try {
      const accepted = await this.dispatch(generation, input);
      if (!this.disposed) {
        if (accepted !== generation && accepted !== this.expectedTakeover) {
          this.queue = [];
          this.uncertain = true;
          this.interrupted();
        }
        this.generation = Math.max(this.generation, accepted);
      }
    } catch {
      this.queue = [];
      if (!this.disposed) {
        this.uncertain = true;
        this.interrupted();
      }
    } finally {
      this.sending = false;
      this.expectedTakeover = 0;
      if (!this.disposed) void this.flush();
    }
  }
  cancel(): void {
    this.queue = [];
  }
  destroy(): void {
    this.disposed = true;
    this.queue = [];
  }
}
