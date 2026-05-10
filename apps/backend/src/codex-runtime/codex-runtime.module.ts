import { Module, forwardRef } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { CodexAgentRuntimeProvider } from './codex-agent-runtime.provider.js';
import { CodexAuthService } from './codex-auth.service.js';
import { CodexHistoryService } from './codex-history.service.js';
import { CodexMcpService } from './codex-mcp.service.js';
import { CodexRuntimeService } from './codex-runtime.service.js';

@Module({
  imports: [forwardRef(() => SessionsModule)],
  providers: [
    CodexAgentRuntimeProvider,
    CodexAuthService,
    CodexHistoryService,
    CodexMcpService,
    CodexRuntimeService,
  ],
  exports: [
    CodexAgentRuntimeProvider,
    CodexAuthService,
    CodexHistoryService,
    CodexMcpService,
    CodexRuntimeService,
  ],
})
export class CodexRuntimeModule {}
