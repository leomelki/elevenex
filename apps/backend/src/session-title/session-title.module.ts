import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionTitleService } from './session-title.service.js';

@Module({
  imports: [SessionsModule],
  providers: [SessionTitleService],
  exports: [SessionTitleService],
})
export class SessionTitleModule {}
