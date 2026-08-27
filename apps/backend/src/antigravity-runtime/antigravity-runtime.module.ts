import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AntigravityAgentRuntimeProvider } from './antigravity-agent-runtime.provider.js';
import { AntigravityAuthService } from './antigravity-auth.service.js';
import { AntigravityMcpService } from './antigravity-mcp.service.js';
import { AntigravityRuntimeService } from './antigravity-runtime.service.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    ClaudeHooksModule,
    SessionTitleModule,
    SettingsModule,
  ],
  providers: [
    AntigravityAgentRuntimeProvider,
    AntigravityAuthService,
    AntigravityMcpService,
    AntigravityRuntimeService,
  ],
  exports: [
    AntigravityAgentRuntimeProvider,
    AntigravityAuthService,
    AntigravityRuntimeService,
  ],
})
export class AntigravityRuntimeModule {}
