import {
  Controller,
  Get,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RuntimeControlService } from './runtime-control.service.js';
import type { BackendRuntimeStatus } from './runtime-control.service.js';

@Controller('runtime')
export class RuntimeControlController {
  constructor(private readonly runtimeControl: RuntimeControlService) {}

  @Get()
  getStatus(): BackendRuntimeStatus {
    return this.runtimeControl.getStatus();
  }

  @Post('restart')
  restart(): BackendRuntimeStatus {
    if (!this.runtimeControl.isRestartSupported()) {
      throw new ServiceUnavailableException(
        'This backend was not started by a launcher that can restart it.',
      );
    }

    return this.runtimeControl.requestRestart();
  }
}
