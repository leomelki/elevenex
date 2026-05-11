import { Module, forwardRef } from '@nestjs/common';
import { ClaudeRuntimeModule } from '../claude-runtime/claude-runtime.module.js';
import { ClaudeRuntimeController } from '../claude-runtime/claude-runtime.controller.js';
import { ClaudeRuntimeGateway } from '../claude-runtime/claude-runtime.gateway.js';
import { CodexRuntimeModule } from '../codex-runtime/codex-runtime.module.js';
import { CodexAgentRuntimeProvider } from '../codex-runtime/codex-agent-runtime.provider.js';
import { PiRuntimeModule } from '../pi-runtime/pi-runtime.module.js';
import { PiAgentRuntimeProvider } from '../pi-runtime/pi-agent-runtime.provider.js';
import { AgentRuntimeController } from './agent-runtime.controller.js';
import { AgentRuntimeCleanupService } from './agent-runtime-cleanup.service.js';
import { AgentRuntimeGateway } from './agent-runtime.gateway.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import { ClaudeAgentRuntimeProvider } from './claude-agent-runtime.provider.js';
import {
  AGENT_RUNTIME_CLEANUP_SERVICE,
  AGENT_RUNTIME_PROVIDERS,
} from './agent-runtime.tokens.js';

@Module({
  imports: [
    forwardRef(() => ClaudeRuntimeModule),
    forwardRef(() => CodexRuntimeModule),
    forwardRef(() => PiRuntimeModule),
  ],
  controllers: [AgentRuntimeController, ClaudeRuntimeController],
  providers: [
    ClaudeAgentRuntimeProvider,
    {
      provide: AGENT_RUNTIME_PROVIDERS,
      useFactory: (
        claudeProvider: ClaudeAgentRuntimeProvider,
        codexProvider: CodexAgentRuntimeProvider,
        piProvider: PiAgentRuntimeProvider,
      ) => [
        claudeProvider,
        codexProvider,
        piProvider,
      ],
      inject: [
        ClaudeAgentRuntimeProvider,
        CodexAgentRuntimeProvider,
        PiAgentRuntimeProvider,
      ],
    },
    AgentRuntimeRegistryService,
    AgentRuntimeCleanupService,
    {
      provide: AGENT_RUNTIME_CLEANUP_SERVICE,
      useExisting: AgentRuntimeCleanupService,
    },
    AgentRuntimeGateway,
    ClaudeRuntimeGateway,
  ],
  exports: [
    AGENT_RUNTIME_CLEANUP_SERVICE,
    AgentRuntimeRegistryService,
    AgentRuntimeGateway,
    ClaudeRuntimeGateway,
  ],
})
export class AgentRuntimeModule {}
