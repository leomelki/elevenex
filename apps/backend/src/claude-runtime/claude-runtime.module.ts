import { Module, forwardRef } from '@nestjs/common';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { ClaudeMcpService } from './claude-mcp.service.js';
import { ClaudeTerminalTranscriptMirrorGateway } from './claude-terminal-transcript-mirror.gateway.js';
import { ClaudeTerminalTranscriptMirrorService } from './claude-terminal-transcript-mirror.service.js';
import { CLAUDE_RUNTIME_SERVICE } from './claude-runtime.tokens.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    forwardRef(() => ClaudeHooksModule),
    forwardRef(() => TerminalModule),
    SessionTitleModule,
  ],
  controllers: [],
  providers: [
    ClaudeRuntimeService,
    ClaudeMcpService,
    ClaudeTerminalTranscriptMirrorService,
    ClaudeTerminalTranscriptMirrorGateway,
    {
      provide: CLAUDE_RUNTIME_SERVICE,
      useExisting: ClaudeRuntimeService,
    },
  ],
  exports: [
    ClaudeRuntimeService,
    ClaudeMcpService,
    ClaudeTerminalTranscriptMirrorGateway,
    ClaudeTerminalTranscriptMirrorService,
    CLAUDE_RUNTIME_SERVICE,
  ],
})
export class ClaudeRuntimeModule {}
