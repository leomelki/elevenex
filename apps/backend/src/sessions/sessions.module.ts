import { Module, forwardRef } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ClaudeRuntimeModule } from '../claude-runtime/claude-runtime.module.js';

@Module({
  imports: [
    forwardRef(() => TerminalModule),
    forwardRef(() => ClaudeRuntimeModule),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
