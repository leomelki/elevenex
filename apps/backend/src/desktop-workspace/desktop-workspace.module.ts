import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { DesktopChatController } from './desktop-chat.controller.js';
import { DesktopChatService } from './desktop-chat.service.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { DesktopWorkspaceActivityService } from './desktop-workspace-activity.service.js';
import { NavigationEventsModule } from '../navigation/navigation-events.module.js';
import { GitModule } from '../git/git.module.js';
import { DesktopWorkspaceGitService } from './desktop-workspace-git.service.js';
import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { DesktopWorkspaceController } from './desktop-workspace.controller.js';
import { DesktopWorkspaceService } from './desktop-workspace.service.js';
import { DesktopProjectDeletionService } from './desktop-project-deletion.service.js';
@Module({
  imports: [
    GitModule,
    AgentRuntimeModule,
    ClaudeHooksModule,
    NavigationEventsModule,
    ProjectsModule,
    ReposModule,
    TasksModule,
    SessionsModule,
    BranchesModule,
  ],
  controllers: [DesktopWorkspaceController, DesktopChatController],
  providers: [
    DesktopChatService,
    DesktopWorkspaceService,
    DesktopWorkspaceGitService,
    DesktopWorkspaceActivityService,
    DesktopProjectDeletionService,
  ],
})
export class DesktopWorkspaceModule {}
