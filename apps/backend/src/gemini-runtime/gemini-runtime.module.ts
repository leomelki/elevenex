import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { GeminiAgentRuntimeProvider } from './gemini-agent-runtime.provider.js';
import { GeminiAuthService } from './gemini-auth.service.js';
import { GeminiHistoryService } from './gemini-history.service.js';
import { GeminiMcpService } from './gemini-mcp.service.js';
import { GeminiRuntimeService } from './gemini-runtime.service.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    ClaudeHooksModule,
    SessionTitleModule,
    SettingsModule,
  ],
  providers: [
    GeminiAgentRuntimeProvider,
    GeminiAuthService,
    GeminiHistoryService,
    GeminiMcpService,
    GeminiRuntimeService,
  ],
  exports: [
    GeminiAgentRuntimeProvider,
    GeminiAuthService,
    GeminiRuntimeService,
  ],
})
export class GeminiRuntimeModule {}
