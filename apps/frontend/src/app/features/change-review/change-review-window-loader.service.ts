import type { ChangeReviewFileWindow } from '@/shared/models/change-review.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';

export interface WindowRequest {
  generation: number;
  filePath: string;
  offset: number;
  key: string;
  /** Capture the scope and options when queued, before the view can change. */
  args: Parameters<ChangeReviewService['getFileWindow']>;
}

type WindowLoadEvent =
  | { type: 'started' | 'finished' | 'stale'; request: WindowRequest }
  | { type: 'loaded'; request: WindowRequest; window: ChangeReviewFileWindow };

/** Per-panel request queue. One in-flight window keeps large reviews responsive. */
@Injectable()
export class ChangeReviewWindowLoader {
  private readonly api = inject(ChangeReviewService);
  private readonly cancel = new Subject<void>();
  private readonly changes = new Subject<WindowLoadEvent>();
  private readonly queue: WindowRequest[] = [];
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly loadState = signal({ running: false, total: 0 });
  private version = 0;
  private inFlight = 0;

  readonly events = this.changes.asObservable();
  readonly state = this.loadState.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.reset();
      this.cancel.complete();
      this.changes.complete();
    });
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  enqueue(request: WindowRequest, priority: boolean): void {
    if (this.pending.has(request.key) || this.failed.has(request.key)) return;
    this.pending.add(request.key);
    if (priority) this.queue.unshift(request);
    else this.queue.push(request);
    this.pump();
  }

  prune(keep: ReadonlySet<string>, generation: number): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const request = this.queue[index];
      if (request.generation === generation && keep.has(request.key)) continue;
      this.pending.delete(request.key);
      this.queue.splice(index, 1);
    }
    this.updateState();
  }

  reset(): void {
    this.version++;
    this.cancel.next();
    this.queue.length = 0;
    this.pending.clear();
    this.failed.clear();
    this.inFlight = 0;
    this.updateState();
  }

  private pump(): void {
    if (this.inFlight === 0 && this.queue.length) this.load(this.queue.shift()!);
    this.updateState();
  }

  private load(request: WindowRequest): void {
    const version = this.version;
    this.inFlight++;
    this.changes.next({ type: 'started', request });
    void firstValueFrom(this.api.getFileWindow(...request.args).pipe(takeUntil(this.cancel)))
      .then((window) => {
        if (version === this.version) this.changes.next({ type: 'loaded', request, window });
      })
      .catch((error: unknown) => {
        if (version !== this.version) return;
        const message = (error as { error?: { message?: string } })?.error?.message;
        if (
          typeof message === 'string' &&
          message.startsWith('File is not changed in this scope:')
        ) {
          // A commit can remove files while their windows are queued. Stop the
          // old queue before asking the panel for a fresh summary.
          this.reset();
          this.changes.next({ type: 'stale', request });
          return;
        }
        // Redrawing or scrolling must not immediately retry a failed window.
        // An explicit refresh resets these failures along with the queue.
        this.failed.add(request.key);
        toast.error(message || 'Could not load file diff.');
      })
      .finally(() => {
        if (version !== this.version) return;
        this.inFlight--;
        this.pending.delete(request.key);
        this.updateState();
        this.changes.next({ type: 'finished', request });
        this.pump();
      });
  }

  private updateState(): void {
    const total = this.queue.length + this.inFlight;
    this.loadState.set({ running: total > 0, total });
  }
}
