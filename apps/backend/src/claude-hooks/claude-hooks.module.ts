import { Module, forwardRef } from '@nestjs/common';
import { ClaudeHooksService } from './claude-hooks.service.js';
import { ClaudeHooksController } from './claude-hooks.controller.js';
import { ClaudeHooksGateway } from './claude-hooks.gateway.js';
import { SessionsModule } from '../sessions/sessions.module.js';

@Module({
  imports: [forwardRef(() => SessionsModule)],
  controllers: [ClaudeHooksController],
  providers: [ClaudeHooksService, ClaudeHooksGateway],
  exports: [ClaudeHooksService, ClaudeHooksGateway],
})
export class ClaudeHooksModule {}
