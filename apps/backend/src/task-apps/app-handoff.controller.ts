import { Controller, ForbiddenException, Post, Req } from '@nestjs/common';
import { hasAppHandoffAccess } from '../config/desktop-access.js';
import type { IncomingMessage } from 'node:http';
import { TaskAppHost } from './task-app-host.js';

/** Only the supervising daemon may stop apps and seal launches before a runtime upgrade. */
@Controller('task-app-runtime')
export class AppHandoffController {
  constructor(private readonly apps: TaskAppHost) {}

  @Post('prepare-handoff')
  async prepare(@Req() request: IncomingMessage) {
    if (!hasAppHandoffAccess(request)) throw new ForbiddenException();
    return { running: await this.apps.prepareRuntimeHandoff() };
  }
}
