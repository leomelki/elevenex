import { Module } from '@nestjs/common';
import { AgentGenerationModule } from '../agent-generation/agent-generation.module.js';
import { ChangeReviewService } from './change-review.service.js';
import { GitController } from './git.controller.js';
import { GitService } from './git.service.js';

@Module({
  imports: [AgentGenerationModule],
  controllers: [GitController],
  providers: [GitService, ChangeReviewService],
  exports: [GitService, ChangeReviewService],
})
export class GitModule {}
