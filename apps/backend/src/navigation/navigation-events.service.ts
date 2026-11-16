import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class NavigationEventsService
  extends EventEmitter
  implements OnModuleDestroy
{
  private currentRevision = 0;
  private destroyed = false;
  private readonly waiters = new Set<() => void>();
  get revision(): number {
    return this.currentRevision;
  }
  invalidate(): void {
    this.currentRevision++;
    for (const wake of this.waiters) wake();
    this.emit('tree-invalidated');
  }

  /** No history or polling work: one bounded wait per visible desktop window. */
  wait(after: number, signal: AbortSignal): Promise<void> {
    if (this.destroyed || after !== this.currentRevision || signal.aborted)
      return Promise.resolve();
    if (this.waiters.size >= 1024)
      throw new ServiceUnavailableException('Too many navigation observers.');
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, 25_000);
      this.waiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const wake of this.waiters) wake();
  }
}
