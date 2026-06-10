import { Module } from '@nestjs/common';
import { TextAgentGenerationService } from './text-agent-generation.service.js';

@Module({
  providers: [TextAgentGenerationService],
  exports: [TextAgentGenerationService],
})
export class AgentGenerationModule {}
