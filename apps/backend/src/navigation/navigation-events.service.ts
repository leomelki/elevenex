import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class NavigationEventsService extends EventEmitter {
  invalidate(): void {
    this.emit('tree-invalidated');
  }
}
