import { Module } from '@nestjs/common';
import { ServerConnectionGateway } from './server-connection.gateway.js';
import { TerminalModule } from '../terminal/terminal.module.js';

@Module({
  imports: [TerminalModule],
  providers: [ServerConnectionGateway],
  exports: [ServerConnectionGateway],
})
export class ServerConnectionModule {}
