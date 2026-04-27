import { Module } from '@nestjs/common';
import { GitController } from './git.controller.js';
import { GitService } from './git.service.js';

@Module({
  controllers: [GitController],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}