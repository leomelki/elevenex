import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  CompleteOnboardingDto,
  UpdateAppSettingsDto,
} from './dto/update-app-settings.dto.js';
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
    return this.settingsService.update(dto);
  }

  @Post('onboarding/complete')
  completeOnboarding(@Body() dto: CompleteOnboardingDto) {
    return this.settingsService.completeOnboarding(dto);
  }
}
