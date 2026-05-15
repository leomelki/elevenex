import { Module } from '@nestjs/common';
import { WorktreesModule } from '../worktrees/worktrees.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspaceCreationJobsService } from './workspace-creation-jobs.service.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  imports: [WorktreesModule, SessionsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceCreationJobsService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
