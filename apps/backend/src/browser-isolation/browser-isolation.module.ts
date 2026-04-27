import { Module } from '@nestjs/common';
import { BrowserIsolationController } from './browser-isolation.controller.js';
import { BrowserIsolationService } from './browser-isolation.service.js';

@Module({
  controllers: [BrowserIsolationController],
  providers: [BrowserIsolationService],
  exports: [BrowserIsolationService],
})
export class BrowserIsolationModule {}
