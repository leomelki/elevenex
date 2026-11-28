import { NavigationEventsModule } from '../navigation/navigation-events.module.js';
import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';

@Module({
  imports: [NavigationEventsModule, SessionsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
