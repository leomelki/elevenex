import { Module } from '@nestjs/common';
import { SessionTitleService } from './session-title.service.js';

@Module({
  providers: [SessionTitleService],
  exports: [SessionTitleService],
})
export class SessionTitleModule {}
