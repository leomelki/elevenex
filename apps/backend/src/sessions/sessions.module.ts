import { Module, forwardRef } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { PlanChatForksService } from './plan-chat-forks.service.js';
import { ReviewChatsService } from './review-chats.service.js';
import { SessionForksService } from './session-forks.service.js';
import { SessionsService } from './sessions.service.js';
import { ComposerDraftsService } from './composer-drafts.service.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SessionFoldersController } from './session-folders.controller.js';
import { SessionFoldersService } from './session-folders.service.js';

@Module({
  imports: [
    forwardRef(() => AgentRuntimeModule),
    forwardRef(() => TerminalModule),
    SettingsModule,
  ],
  controllers: [SessionsController, SessionFoldersController],
  providers: [
    SessionsService,
    SessionForksService,
    PlanChatForksService,
    ReviewChatsService,
    ComposerDraftsService,
    SessionFoldersService,
  ],
  exports: [
    SessionsService,
    SessionForksService,
    PlanChatForksService,
    ReviewChatsService,
    ComposerDraftsService,
    SessionFoldersService,
  ],
})
export class SessionsModule {}
