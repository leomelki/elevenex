import { Module } from '@nestjs/common';
import { WorktreesController } from './worktrees.controller.js';
import { WorktreesService } from './worktrees.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorktreeCreationJobsService } from './worktree-creation-jobs.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { WorktreePoolService } from './worktree-pool.service.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';

@Module({
  imports: [ProjectsModule, SessionsModule, ClaudeHooksModule],
  controllers: [WorktreesController],
  providers: [WorktreesService, WorktreeCreationJobsService, WorktreePoolService],
  exports: [WorktreesService, WorktreeCreationJobsService, WorktreePoolService],
})
export class WorktreesModule {}
