import { Module } from '@nestjs/common';
import { UserTerminalController } from './user-terminal.controller.js';
import { UserTerminalService } from './user-terminal.service.js';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { UserPtyManager } from './user-pty-manager.service.js';

@Module({
  controllers: [UserTerminalController],
  providers: [
    UserTerminalService,
    UserTerminalGateway,
    UserPtyManager,
  ],
  exports: [
    UserTerminalService,
    UserTerminalGateway,
    UserPtyManager,
  ],
})
export class UserTerminalModule {}
