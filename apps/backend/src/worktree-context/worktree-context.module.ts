import { Module, forwardRef } from '@nestjs/common';
import { WorktreeContextController } from './worktree-context.controller.js';
import { WorktreeContextService } from './worktree-context.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentGenerationModule } from '../agent-generation/agent-generation.module.js';

@Module({
  imports: [forwardRef(() => SessionsModule), AgentGenerationModule],
  controllers: [WorktreeContextController],
  providers: [WorktreeContextService],
  exports: [WorktreeContextService],
})
export class WorktreeContextModule {}
