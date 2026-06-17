import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ElevenexAgentMissionsService } from './elevenex-agent-missions.service.js';
import { CreateMissionDto } from './dto/create-mission.dto.js';
import { SetAutonomyDto } from './dto/set-autonomy.dto.js';

/**
 * Mission control API. A mission IS a hidden `surface:'agent'` session driven by
 * the meta-agent runtime. Mounted at /api/agent/missions (global 'api' prefix).
 */
@Controller('agent/missions')
export class ElevenexAgentController {
  constructor(private readonly missions: ElevenexAgentMissionsService) {}

  @Post()
  create(@Body() dto: CreateMissionDto) {
    return this.missions.createMission({
      prompt: dto.prompt,
      autonomyMode: dto.autonomyMode,
      model: dto.model ?? null,
    });
  }

  @Get()
  list() {
    return this.missions.listMissions();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.missions.getMission(+id);
  }

  @Post(':id/autonomy')
  setAutonomy(@Param('id') id: string, @Body() dto: SetAutonomyDto) {
    return this.missions.setAutonomy(+id, dto.autonomyMode);
  }

  @Post(':id/interrupt')
  async interrupt(@Param('id') id: string) {
    await this.missions.interruptMission(+id);
    return { ok: true };
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    await this.missions.archiveMission(+id);
    return { ok: true };
  }
}
