import { Module } from '@nestjs/common';
import { NavigationEventsService } from './navigation-events.service.js';

@Module({
  providers: [NavigationEventsService],
  exports: [NavigationEventsService],
})
export class NavigationEventsModule {}
