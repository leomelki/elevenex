import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposController } from './repos.controller.js';
import { ReposService } from './repos.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
