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
import { RuntimeVideoHost } from '../desktop-browser/runtime-video-host.js';
import { TaskAppJournal } from '../task-apps/task-app-journal.js';
import { TaskAppHost } from '../task-apps/task-app-host.js';
import { TasksService } from './tasks.service.js';
import { TasksController } from './tasks.controller.js';
import { WorktreeContextModule } from '../worktree-context/worktree-context.module.js';

@Module({
  imports: [
    ProjectsModule,
    SessionsModule,
    WorktreeContextModule,
    WorktreesModule,
    BranchesModule,
    ClaudeHooksModule,
    UserTerminalModule,
    ActionsModule,
    NavigationEventsModule,
  ],
  controllers: [TasksController],
  providers: [
    { provide: RuntimeVideoHost, useFactory: () => new RuntimeVideoHost() },
    TaskAppJournal,
    TaskAppHost,
    TaskGitService,
    TaskWorktreeAllocator,
    TasksService,
  ],
  exports: [TasksService, TaskGitService, TaskAppHost, RuntimeVideoHost],
})
export class TasksModule {}
