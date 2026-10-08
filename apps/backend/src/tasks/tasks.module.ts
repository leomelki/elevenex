import { Module } from '@nestjs/common';
import { NavigationEventsModule } from '../navigation/navigation-events.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorktreesModule } from '../worktrees/worktrees.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { UserTerminalModule } from '../user-terminal/user-terminal.module.js';
import { ActionsModule } from '../actions/actions.module.js';
import { TaskGitService } from './task-git.service.js';
import { TaskWorktreeAllocator } from './task-worktree-allocator.service.js';
import { TasksService } from './tasks.service.js';
import { TasksController } from './tasks.controller.js';

@Module({
  imports: [
    ProjectsModule,
    SessionsModule,
    WorktreesModule,
    BranchesModule,
    ClaudeHooksModule,
    UserTerminalModule,
    ActionsModule,
    NavigationEventsModule,
  ],
  controllers: [TasksController],
  providers: [TaskGitService, TaskWorktreeAllocator, TasksService],
  exports: [TasksService],
})
export class TasksModule {}
