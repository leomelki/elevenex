import { Module } from '@nestjs/common';
import { ElevenexAgentService } from './elevenex-agent.service.js';
import { AgentStandbyService } from './agent-standby.service.js';
import { ElevenexAgentMissionsService } from './elevenex-agent-missions.service.js';
import { ElevenexAgentController } from './elevenex-agent.controller.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReposModule } from '../repos/repos.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ClaudeRuntimeModule } from '../claude-runtime/claude-runtime.module.js';
import { ElevenexMcpModule } from '../mcp/elevenex-mcp.module.js';

/**
 * Hosts the agent-workspace bootstrap and the missions API. "A mission IS an
 * agent session", so this composes existing services:
 *  - Projects/Repos — provision the hidden "Elevenex Agent" project+repo.
 *  - Sessions — create/list/start/archive the agent sessions.
 *  - ClaudeRuntime — drive them (submitPrompt, autonomy, interrupt).
 *  - McpModule — reuse `McpAgentTokenService` to mint each mission's
 *    ELEVENEX_AGENT_TOKEN (kept a leaf service to avoid a module cycle).
 */
@Module({
  imports: [
    ProjectsModule,
    ReposModule,
    SessionsModule,
    ClaudeRuntimeModule,
    ElevenexMcpModule,
  ],
  controllers: [ElevenexAgentController],
  providers: [ElevenexAgentService, AgentStandbyService, ElevenexAgentMissionsService],
  exports: [ElevenexAgentService],
})
export class ElevenexAgentModule {}
