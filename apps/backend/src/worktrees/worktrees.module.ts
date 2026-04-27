import { Module } from '@nestjs/common';
import { WorktreesController } from './worktrees.controller.js';
import { WorktreesService } from './worktrees.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorktreeCreationJobsService } from './worktree-creation-jobs.service.js';

@Module({
  imports: [SessionsModule],
  controllers: [WorktreesController],
  providers: [WorktreesService, WorktreeCreationJobsService],
  exports: [WorktreesService, WorktreeCreationJobsService],
})
export class WorktreesModule {}
