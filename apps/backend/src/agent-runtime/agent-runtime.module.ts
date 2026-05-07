import { Module, forwardRef } from '@nestjs/common';
import { ClaudeRuntimeModule } from '../claude-runtime/claude-runtime.module.js';
import { ClaudeRuntimeController } from '../claude-runtime/claude-runtime.controller.js';
import { ClaudeRuntimeGateway } from '../claude-runtime/claude-runtime.gateway.js';
import { AgentRuntimeController } from './agent-runtime.controller.js';
import { AgentRuntimeGateway } from './agent-runtime.gateway.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import { ClaudeAgentRuntimeProvider } from './claude-agent-runtime.provider.js';
import { AGENT_RUNTIME_PROVIDERS } from './agent-runtime.tokens.js';

@Module({
  imports: [forwardRef(() => ClaudeRuntimeModule)],
  controllers: [AgentRuntimeController, ClaudeRuntimeController],
  providers: [
    ClaudeAgentRuntimeProvider,
    {
      provide: AGENT_RUNTIME_PROVIDERS,
      useFactory: (claudeProvider: ClaudeAgentRuntimeProvider) => [
        claudeProvider,
      ],
      inject: [ClaudeAgentRuntimeProvider],
    },
    AgentRuntimeRegistryService,
    AgentRuntimeGateway,
    ClaudeRuntimeGateway,
  ],
  exports: [
    AgentRuntimeRegistryService,
    AgentRuntimeGateway,
    ClaudeRuntimeGateway,
  ],
})
export class AgentRuntimeModule {}
