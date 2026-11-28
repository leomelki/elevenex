import type { TaskAppInput } from '@elevenex/shared';

/** Serialize gestures. Replace only adjacent motion so down/up and key order survive a slow link. */
export class AppInputQueue {
  private readonly queue: TaskAppInput[] = [];
  private generation = 0;
  private inflight = 0;
  constructor(private readonly send: (input: TaskAppInput) => Promise<void>, private readonly interrupted: (reason?: unknown) => void) {}

  push(event: TaskAppInput): void {
    if (event.kind === 'move' && this.queue.at(-1)?.kind === 'move') this.queue[this.queue.length - 1] = event;
    else if (this.queue.length < 64) this.queue.push(event);
    else { this.cancel(); this.interrupted(); return; }
    this.drain();
  }

  cancel(): void { this.generation++; this.queue.length = 0; }

  // IPC and the host's ordered control channel preserve submission order.
  // A small outstanding window prevents one RTT per key or pointer transition.
  private drain(): void {
    while (this.queue.length && this.inflight < 4) {
      const event = this.queue.shift()!;
      const generation = this.generation;
      this.inflight++;
      void this.send(event).catch((error: unknown) => {
        if (generation === this.generation) { this.cancel(); this.interrupted(error); }
      }).finally(() => { this.inflight--; this.drain(); });
    }
  }
}

export function appPoint(event: MouseEvent, canvas: HTMLCanvasElement, width: number, height: number): { x: number; y: number } | null {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * width / bounds.width))),
    y: Math.min(height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * height / bounds.height))),
  };
}
