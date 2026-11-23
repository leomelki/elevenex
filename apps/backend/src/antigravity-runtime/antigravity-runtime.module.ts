import { Module, forwardRef } from '@nestjs/common';
import { TurnChangesModule } from '../agent-runtime/turn-changes.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AntigravityRuntimeProvider } from './antigravity-runtime.provider.js';

@Module({
  imports: [
    forwardRef(() => SessionsModule),
    SettingsModule,
    TurnChangesModule,
  ],
  providers: [AntigravityRuntimeProvider],
  exports: [AntigravityRuntimeProvider],
})
export class AntigravityRuntimeModule {}
