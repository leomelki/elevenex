import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { BrowserIsolationService } from './browser-isolation.service.js';
import { UpsertBrowserIsolationDto } from './dto/upsert-browser-isolation.dto.js';

@Controller('browser-isolation')
export class BrowserIsolationController {
  constructor(private readonly service: BrowserIsolationService) {}

  @Get()
  findOne(@Query('projectId') projectId: string) {
    return this.service.findOne(+projectId);
  }

  @Patch()
  upsert(@Body() dto: UpsertBrowserIsolationDto) {
    return this.service.upsert(dto.projectId, dto.mode, dto.sharedGlobs);
  }
}
