import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ProjectBrowserStateService } from './project-browser-state.service.js';
import { UpsertProjectBrowserStateDto } from './dto/upsert-project-browser-state.dto.js';

@Controller('project-browser-state')
export class ProjectBrowserStateController {
  constructor(private readonly service: ProjectBrowserStateService) {}

  @Get()
  findOne(@Query('projectId') projectId: string) {
    return this.service.findOne(+projectId);
  }

  @Patch()
  upsert(@Body() dto: UpsertProjectBrowserStateDto) {
    return this.service.upsert(dto);
  }
}
