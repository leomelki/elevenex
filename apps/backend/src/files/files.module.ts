import { Module } from '@nestjs/common';
import { FilesController, FilesystemController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Module({
  controllers: [FilesController, FilesystemController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}