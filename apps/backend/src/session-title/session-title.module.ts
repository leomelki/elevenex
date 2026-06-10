import { Module } from '@nestjs/common';
import { AgentGenerationModule } from '../agent-generation/agent-generation.module.js';
import { SessionTitleService } from './session-title.service.js';

@Module({
  imports: [AgentGenerationModule],
  providers: [SessionTitleService],
  exports: [SessionTitleService],
})
export class SessionTitleModule {}
