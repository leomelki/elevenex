import { Controller, Get } from '@nestjs/common';
import { NavigationService } from './navigation.service.js';

@Controller('navigation')
export class NavigationController {
  constructor(private readonly navigationService: NavigationService) {}

  @Get('tree/light')
  getNavigationTreeLight() {
    return this.navigationService.getNavigationTreeLight();
  }

  @Get('tree')
  getNavigationTree() {
    return this.navigationService.getNavigationTree();
  }
}