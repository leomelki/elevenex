import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../../projects/projects.service.js';
import { ReposService } from '../../repos/repos.service.js';
import { SessionsService } from '../../sessions/sessions.service.js';
import { SessionForksService } from '../../sessions/session-forks.service.js';
import { PlanChatForksService } from '../../sessions/plan-chat-forks.service.js';
import { WorktreePoolService } from '../../worktrees/worktree-pool.service.js';
import { WorktreeCreationJobsService } from '../../worktrees/worktree-creation-jobs.service.js';
import { WorktreesService } from '../../worktrees/worktrees.service.js';
import { WorkspacesService } from '../../workspaces/workspaces.service.js';
import { GitService } from '../../git/git.service.js';
import { ChangeReviewService } from '../../git/change-review.service.js';
import { FilesService } from '../../files/files.service.js';
import { ActionsService } from '../../actions/actions.service.js';
import { TodosService } from '../../todos/todos.service.js';
import { ScratchpadService } from '../../scratchpad/scratchpad.service.js';
import { WorktreeContextService } from '../../worktree-context/worktree-context.service.js';
import { AgentRuntimeRegistryService } from '../../agent-runtime/agent-runtime-registry.service.js';
import { ConversationExportService } from '../../agent-runtime/conversation-export.service.js';
import { AgentFocusService } from '../../agent-focus/agent-focus.service.js';

/**
 * Injectable bag of the existing domain services the MCP tools reuse
 * **in-process** (no loopback HTTP). Tools receive this via `ToolContext` so a
 * tool file only depends on this surface, never on Nest DI wiring directly.
 */
@Injectable()
export class McpToolServices {
  constructor(
    readonly projects: ProjectsService,
    readonly repos: ReposService,
    readonly sessions: SessionsService,
    readonly sessionForks: SessionForksService,
    readonly planChatForks: PlanChatForksService,
    readonly worktreePool: WorktreePoolService,
    readonly worktreeJobs: WorktreeCreationJobsService,
    readonly worktrees: WorktreesService,
    readonly workspaces: WorkspacesService,
    readonly git: GitService,
    readonly changeReview: ChangeReviewService,
    readonly files: FilesService,
    readonly actions: ActionsService,
    readonly todos: TodosService,
    readonly scratchpad: ScratchpadService,
    readonly worktreeContext: WorktreeContextService,
    readonly agentRuntime: AgentRuntimeRegistryService,
    readonly conversationExport: ConversationExportService,
    readonly agentFocus: AgentFocusService,
  ) {}
}
