import { Module, forwardRef } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';

@Module({
  imports: [
    forwardRef(() => AgentRuntimeModule),
    forwardRef(() => TerminalModule),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
