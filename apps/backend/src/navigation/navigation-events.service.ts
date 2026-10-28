import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class NavigationEventsService extends EventEmitter {
  private currentRevision = 0;
  get revision(): number {
    return this.currentRevision;
  }
  invalidate(): void {
    this.currentRevision++;
    this.emit('tree-invalidated');
  }
}
