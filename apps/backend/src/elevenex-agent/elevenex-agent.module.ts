import { Module } from '@nestjs/common';
import { ElevenexAgentController } from './elevenex-agent.controller.js';
import { ElevenexAgentService } from './elevenex-agent.service.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';

@Module({
  imports: [ProjectsModule, SessionsModule],
  controllers: [ElevenexAgentController],
  providers: [ElevenexAgentService],
  exports: [ElevenexAgentService],
})
export class ElevenexAgentModule {}
