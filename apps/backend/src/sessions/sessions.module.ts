import { Module, forwardRef } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { PlanChatForksService } from './plan-chat-forks.service.js';
import { SessionForksService } from './session-forks.service.js';
import { SessionsService } from './sessions.service.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';

@Module({
  imports: [
    forwardRef(() => AgentRuntimeModule),
    forwardRef(() => TerminalModule),
    SettingsModule,
  ],
  controllers: [SessionsController],
  providers: [SessionsService, SessionForksService, PlanChatForksService],
  exports: [SessionsService, SessionForksService, PlanChatForksService],
})
export class SessionsModule {}
