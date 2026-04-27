import { Module } from '@nestjs/common';
import { ProjectBrowserStateController } from './project-browser-state.controller.js';
import { ProjectBrowserStateService } from './project-browser-state.service.js';

@Module({
  controllers: [ProjectBrowserStateController],
  providers: [ProjectBrowserStateService],
  exports: [ProjectBrowserStateService],
})
export class ProjectBrowserStateModule {}
