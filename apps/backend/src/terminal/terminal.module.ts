import { Module, forwardRef } from '@nestjs/common';
import { TerminalService } from './terminal.service.js';
import { TerminalGateway } from './terminal.gateway.js';
import { PtyManager } from './pty-manager.service.js';
import { TmuxManager } from './tmux-manager.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ClaudeHooksModule } from '../claude-hooks/claude-hooks.module.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    forwardRef(() => ClaudeHooksModule),
  ],
  providers: [
    TerminalService,
    TerminalGateway,
    PtyManager,
    TmuxManager,
  ],
  exports: [
    TerminalService,
    TerminalGateway,
    PtyManager,
    TmuxManager,
  ],
})
export class TerminalModule {}
