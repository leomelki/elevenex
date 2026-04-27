import { Module, forwardRef } from '@nestjs/common';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { ClaudeRuntimeGateway } from './claude-runtime.gateway.js';
import { ClaudeRuntimeController } from './claude-runtime.controller.js';
import { ClaudeMcpService } from './claude-mcp.service.js';
import { CLAUDE_RUNTIME_SERVICE } from './claude-runtime.tokens.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    forwardRef(() => ClaudeHooksModule),
    forwardRef(() => TerminalModule),
  ],
  controllers: [ClaudeRuntimeController],
  providers: [
    ClaudeRuntimeService,
    ClaudeRuntimeGateway,
    ClaudeMcpService,
    {
      provide: CLAUDE_RUNTIME_SERVICE,
      useExisting: ClaudeRuntimeService,
    },
  ],
  exports: [
    ClaudeRuntimeService,
    ClaudeRuntimeGateway,
    ClaudeMcpService,
    CLAUDE_RUNTIME_SERVICE,
  ],
})
export class ClaudeRuntimeModule {}
