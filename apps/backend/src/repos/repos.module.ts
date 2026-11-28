import { NavigationEventsModule } from '../navigation/navigation-events.module.js';
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposController } from './repos.controller.js';
import { ReposService } from './repos.service.js';

@Module({
  imports: [NavigationEventsModule, ProjectsModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
