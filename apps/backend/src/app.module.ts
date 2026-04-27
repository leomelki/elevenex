import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { ReposModule } from './repos/repos.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { WorktreesModule } from './worktrees/worktrees.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { NavigationModule } from './navigation/navigation.module.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { FilesModule } from './files/files.module.js';
import { GitModule } from './git/git.module.js';
import { ScratchpadModule } from './scratchpad/scratchpad.module.js';
import { TodosModule } from './todos/todos.module.js';
import { PlannotatorModule } from './plannotator/plannotator.module.js';
import { UserTerminalModule } from './user-terminal/user-terminal.module.js';
import { FileWatcherModule } from './file-watcher/file-watcher.module.js';
import { ClaudeHooksModule } from './claude-hooks/claude-hooks.module.js';
import { ProjectBrowserStateModule } from './project-browser-state/project-browser-state.module.js';
import { BrowserIsolationModule } from './browser-isolation/browser-isolation.module.js';
import { ActionsModule } from './actions/actions.module.js';
import { GithubModule } from './github/github.module.js';
import { ClaudeRuntimeModule } from './claude-runtime/claude-runtime.module.js';
import { WorktreeContextModule } from './worktree-context/worktree-context.module.js';

@Module({
  imports: [
    DatabaseModule,
    ProjectsModule,
    ReposModule,
    BranchesModule,
    WorktreesModule,
    SessionsModule,
    NavigationModule,
    TerminalModule,
    FilesModule,
    GitModule,
    ScratchpadModule,
    TodosModule,
    PlannotatorModule,
    UserTerminalModule,
    FileWatcherModule,
    ClaudeHooksModule,
    ProjectBrowserStateModule,
    BrowserIsolationModule,
    ActionsModule,
    GithubModule,
    ClaudeRuntimeModule,
    WorktreeContextModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
