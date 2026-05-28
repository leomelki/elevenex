import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksService } from './claude-hooks.service.js';
import { ClaudeHooksController } from './claude-hooks.controller.js';
import { ClaudeHooksGateway } from './claude-hooks.gateway.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WorktreeContextModule } from '../worktree-context/worktree-context.module.js';
import { SessionTitleModule } from '../session-title/session-title.module.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    forwardRef(() => WorktreeContextModule),
    SessionTitleModule,
  ],
  controllers: [ClaudeHooksController],
  providers: [ClaudeHooksService, ClaudeHooksGateway],
  exports: [ClaudeHooksService, ClaudeHooksGateway],
})
export class ClaudeHooksModule {}
