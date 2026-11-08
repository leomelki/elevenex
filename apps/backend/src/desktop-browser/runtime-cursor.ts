import { browserCursors, type TaskBrowserCursor } from '@elevenex/shared';
import type { Page } from 'playwright-core';

interface CursorRead {
  readonly x: number;
  readonly y: number;
  current(): boolean;
}

/** Optional presentation metadata must never hold the ordered input lane.
 * Keep one page read in flight and coalesce motion to its latest position.
 */
export class RuntimeBrowserCursor {
  private latest?: CursorRead;
  private reading = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly page: Page,
    private readonly publish: (cursor: TaskBrowserCursor) => void,
  ) {}

  update(x: number, y: number, current: () => boolean): void {
    if (this.disposed) return;
    this.latest = { x, y, current };
    this.schedule();
  }

  reset(): void {
    this.latest = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  destroy(): void {
    this.disposed = true;
    this.reset();
  }

  private schedule(): void {
    if (this.disposed || this.reading || this.timer || !this.latest) return;
    // Hit testing can force style/layout on busy pages. Bound its frequency,
    // including down/up bursts, without delaying native event delivery.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.read();
    }, 32);
  }

  private async read(): Promise<void> {
    const read = this.latest;
    if (!read || !read.current() || this.disposed) return;
    this.reading = true;
    try {
      const cursor = await this.page.evaluate(
        ({ x, y }) => {
          let element = document.elementFromPoint(x, y);
          while (element?.shadowRoot) {
            const inner = element.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === element) break;
            element = inner;
          }
          if (!element) return 'default';
          const cursor = getComputedStyle(element).cursor;
          if (
            cursor === 'auto' &&
            element.closest(
              'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]',
            )
          )
            return 'text';
          // Never relay custom cursor URLs or page-provided CSS expressions.
          return cursor.split(',').at(-1)?.trim() ?? 'default';
        },
        { x: read.x, y: read.y },
      );
      if (!this.disposed && this.latest === read && read.current())
        this.publish(
          browserCursors.find((value) => value === cursor) ?? 'default',
        );
    } catch {
      // A replaced/busy document cannot turn a delivered gesture into a failure.
    } finally {
      this.reading = false;
      if (this.latest === read) this.latest = undefined;
      this.schedule();
    }
  }
}
