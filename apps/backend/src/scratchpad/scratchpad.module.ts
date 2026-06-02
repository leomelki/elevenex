import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ScratchpadController, ScratchpadSectionController } from './scratchpad.controller.js';
import { ScratchpadService } from './scratchpad.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [ScratchpadController, ScratchpadSectionController],
  providers: [ScratchpadService],
  exports: [ScratchpadService],
})
export class ScratchpadModule {}
