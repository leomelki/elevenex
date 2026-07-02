import { Module } from '@nestjs/common';
import { NavigationController } from './navigation.controller.js';
import { NavigationService } from './navigation.service.js';
import { NavigationEventsService } from './navigation-events.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';

@Module({
  imports: [ProjectsModule, ReposModule, SessionsModule, WorkspacesModule],
  controllers: [NavigationController],
  providers: [NavigationService, NavigationEventsService],
  exports: [NavigationEventsService],
})
export class NavigationModule {}
