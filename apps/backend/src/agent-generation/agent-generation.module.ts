import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { TextAgentGenerationService } from './text-agent-generation.service.js';

@Module({
  imports: [SettingsModule],
  providers: [TextAgentGenerationService],
  exports: [TextAgentGenerationService],
})
export class AgentGenerationModule {}
