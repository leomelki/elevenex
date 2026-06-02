import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ProjectBrowserStateController } from './project-browser-state.controller.js';
import { ProjectBrowserStateService } from './project-browser-state.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ProjectBrowserStateController],
  providers: [ProjectBrowserStateService],
  exports: [ProjectBrowserStateService],
})
export class ProjectBrowserStateModule {}
