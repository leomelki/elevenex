import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorktreesModule } from '../worktrees/worktrees.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { GitModule } from '../git/git.module.js';
import { FilesModule } from '../files/files.module.js';
import { ActionsModule } from '../actions/actions.module.js';
import { TodosModule } from '../todos/todos.module.js';
import { ScratchpadModule } from '../scratchpad/scratchpad.module.js';
import { WorktreeContextModule } from '../worktree-context/worktree-context.module.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';

import { McpToolServices } from './tool-registry/mcp-tool-services.js';
import { DeltaCursorStore } from './tool-registry/delta-cursor.store.js';
import { ToolRegistryService } from './tool-registry/tool-registry.service.js';
import { DeepLinkBuilder } from './deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from './human-channel/human-channel.js';
import { AgentChannelGateway } from './human-channel/agent-channel.gateway.js';
import { McpAgentTokenService } from './identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from './connection/mcp-connection-registry.service.js';
import { McpServerFactory } from './transport/mcp-server.factory.js';
import { ElevenexMcpHttpTransport } from './transport/elevenex-mcp-http.transport.js';

/**
 * In-process Elevenex MCP server. Downstream-only: it consumes the domain
 * modules and nothing consumes it, so it adds no circular deps. The HTTP
 * transport is mounted as a raw Express route in main.ts (pre-body-parser);
 * this module just wires the server, registry, and reused services.
 */
@Module({
  imports: [
    DatabaseModule,
    ProjectsModule,
    ReposModule,
    SessionsModule,
    WorktreesModule,
    WorkspacesModule,
    GitModule,
    FilesModule,
    ActionsModule,
    TodosModule,
    ScratchpadModule,
    WorktreeContextModule,
    AgentRuntimeModule,
  ],
  providers: [
    McpToolServices,
    DeltaCursorStore,
    DeepLinkBuilder,
    AgentHumanChannelService,
    McpAgentTokenService,
    McpConnectionRegistryService,
    ToolRegistryService,
    McpServerFactory,
    ElevenexMcpHttpTransport,
    AgentChannelGateway,
  ],
  exports: [
    // main.ts mounts the transport + the agent-channel gateway; the token
    // service is reused by the agent-session creation path to mint
    // ELEVENEX_AGENT_TOKEN.
    ElevenexMcpHttpTransport,
    AgentChannelGateway,
    McpAgentTokenService,
    AgentHumanChannelService,
    McpConnectionRegistryService,
  ],
})
export class ElevenexMcpModule {}
