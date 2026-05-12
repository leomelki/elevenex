import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';
import { PiAgentRuntimeProvider } from './pi-agent-runtime.provider.js';
import { PiAuthService } from './pi-auth.service.js';
import { PiRuntimeService } from './pi-runtime.service.js';

@Module({
  imports: [forwardRef(() => SessionsModule), ClaudeHooksModule, SessionTitleModule],
  providers: [PiAgentRuntimeProvider, PiAuthService, PiRuntimeService],
  exports: [PiAgentRuntimeProvider, PiAuthService, PiRuntimeService],
})
export class PiRuntimeModule {}
