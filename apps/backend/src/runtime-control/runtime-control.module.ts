import { Module } from '@nestjs/common';
import { RuntimeControlController } from './runtime-control.controller.js';
import { RuntimeControlService } from './runtime-control.service.js';

@Module({
  controllers: [RuntimeControlController],
  providers: [RuntimeControlService],
  exports: [RuntimeControlService],
})
export class RuntimeControlModule {}
