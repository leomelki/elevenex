import {
  DesktopTerminalController,
  DesktopTerminalOwnerController,
} from './desktop-terminal.controller.js';
import { DesktopTerminalService } from './desktop-terminal.service.js';
import { Module } from '@nestjs/common';
import { UserTerminalController } from './user-terminal.controller.js';
import { UserTerminalService } from './user-terminal.service.js';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { UserPtyManager } from './user-pty-manager.service.js';
import { DesktopTerminalGateway } from './stream/desktop-terminal.gateway.js';

@Module({
  controllers: [
    UserTerminalController,
    DesktopTerminalController,
    DesktopTerminalOwnerController,
  ],
  providers: [
    DesktopTerminalGateway,
    DesktopTerminalService,
    UserTerminalService,
    UserTerminalGateway,
    UserPtyManager,
  ],
  exports: [UserTerminalService, UserTerminalGateway, UserPtyManager, DesktopTerminalGateway],
})
export class UserTerminalModule {}
