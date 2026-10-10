import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import { OpenCodeCatalogService } from './opencode-catalog.service.js';
import { OpenCodeAgentRuntimeProvider } from './opencode-agent-runtime.provider.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    ClaudeHooksModule,
    SessionTitleModule,
    SettingsModule,
  ],
  providers: [
    OpenCodeCatalogService,
    OpenCodeAgentRuntimeProvider,
    McpAgentTokenService,
  ],
  exports: [OpenCodeAgentRuntimeProvider],
})
export class OpenCodeRuntimeModule {}
