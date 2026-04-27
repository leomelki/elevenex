import { Module } from '@nestjs/common';
import { FileWatcherService } from './file-watcher.service.js';
import { FileChangeGateway } from './file-change.gateway.js';

@Module({
  providers: [FileWatcherService, FileChangeGateway],
  exports: [FileWatcherService, FileChangeGateway],
})
export class FileWatcherModule {}