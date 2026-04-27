import { Module } from '@nestjs/common';
import { ActionsController } from './actions.controller.js';
import { ActionsGateway } from './actions.gateway.js';
import { ActionPtyManager } from './action-pty-manager.service.js';
import { ActionsService } from './actions.service.js';

@Module({
  controllers: [ActionsController],
  providers: [
    ActionsService,
    ActionsGateway,
    ActionPtyManager,
  ],
  exports: [
    ActionsService,
    ActionsGateway,
    ActionPtyManager,
  ],
})
export class ActionsModule {}
