import { Module } from '@nestjs/common';
import { ServerConnectionGateway } from './server-connection.gateway.js';

@Module({
  providers: [ServerConnectionGateway],
  exports: [ServerConnectionGateway],
})
export class ServerConnectionModule {}
