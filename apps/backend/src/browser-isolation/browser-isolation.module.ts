import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { BrowserIsolationController } from './browser-isolation.controller.js';
import { BrowserIsolationService } from './browser-isolation.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [BrowserIsolationController],
  providers: [BrowserIsolationService],
  exports: [BrowserIsolationService],
})
export class BrowserIsolationModule {}
