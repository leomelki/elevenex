import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto.js';
import { SettingsService } from './settings.service.js';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  findOne() {
    return this.settingsService.findOne();
  }

  @Patch()
  update(@Body() dto: UpdateAppSettingsDto) {
    return this.settingsService.update(dto.defaultClaudeSessionSurface);
  }
}
