import { execSync } from 'child_process';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { getElevenexProxyPort } from '../config/ports.js';
import { PlannotatorRegistryService } from './plannotator-registry.service.js';
import type {
  RegisterClosePayload,
  RegisterOpenPayload,
  RegisterOpenResult,
} from './plannotator-registry.service.js';

@Controller('plannotator')
export class PlannotatorController {
  constructor(private readonly registry: PlannotatorRegistryService) {}

  @Post('register-open')
  registerOpen(@Body() body: RegisterOpenPayload): RegisterOpenResult {
    return this.registry.registerOpen(body);
  }

  @Post('register-close')
  registerClose(@Body() body: RegisterClosePayload): { ok: boolean } {
    return { ok: this.registry.registerClose(body) };
  }

  @Get('health')
  health(): { status: string; proxyPort: number } {
    return {
      status: 'ok',
      proxyPort: getElevenexProxyPort(),
    };
  }

  @Get('installed')
  isInstalled(): { installed: boolean } {
    try {
      execSync('which plannotator', { stdio: 'ignore' });
      return { installed: true };
    } catch {
      return { installed: false };
    }
  }
}
