import { Module } from '@nestjs/common';
import { ChangeReviewService } from './change-review.service.js';
import { GitController } from './git.controller.js';
import { GitService } from './git.service.js';

@Module({
  controllers: [GitController],
  providers: [GitService, ChangeReviewService],
  exports: [GitService, ChangeReviewService],
})
export class GitModule {}
