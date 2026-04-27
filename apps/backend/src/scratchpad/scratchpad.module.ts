import { Module } from '@nestjs/common';
import { ScratchpadController, ScratchpadSectionController } from './scratchpad.controller.js';
import { ScratchpadService } from './scratchpad.service.js';

@Module({
  controllers: [ScratchpadController, ScratchpadSectionController],
  providers: [ScratchpadService],
  exports: [ScratchpadService],
})
export class ScratchpadModule {}