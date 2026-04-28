import { Module } from '@nestjs/common';
import { BackendLogsGateway } from './backend-logs.gateway.js';

@Module({
  providers: [BackendLogsGateway],
  exports: [BackendLogsGateway],
})
export class BackendLogsModule {}
