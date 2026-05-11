import { Module, forwardRef } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { PiAgentRuntimeProvider } from './pi-agent-runtime.provider.js';
import { PiAuthService } from './pi-auth.service.js';
import { PiRuntimeService } from './pi-runtime.service.js';

@Module({
  imports: [forwardRef(() => SessionsModule)],
  providers: [PiAgentRuntimeProvider, PiAuthService, PiRuntimeService],
  exports: [PiAgentRuntimeProvider, PiAuthService, PiRuntimeService],
})
export class PiRuntimeModule {}
