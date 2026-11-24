import { Module, forwardRef } from '@nestjs/common';
import { TurnChangesModule } from '../agent-runtime/turn-changes.module.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';
import { AntigravityRuntimeProvider } from './antigravity-runtime.provider.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    SettingsModule,
    SessionTitleModule,
    TurnChangesModule,
  ],
  providers: [AntigravityRuntimeProvider, McpAgentTokenService],
  exports: [AntigravityRuntimeProvider],
})
export class AntigravityRuntimeModule {}
