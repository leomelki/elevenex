import { Body, Controller, Get, Post } from '@nestjs/common';
import { ElevenexAgentService } from './elevenex-agent.service.js';

interface CreateAgentSessionBody {
  name?: string;
}

@Controller('agent')
export class ElevenexAgentController {
  constructor(private readonly agentService: ElevenexAgentService) {}

  @Get()
  getOverview() {
    return this.agentService.getOverview();
  }

  @Post('sessions')
  createSession(@Body() body: CreateAgentSessionBody) {
    return this.agentService.createSession(body?.name);
  }
}
