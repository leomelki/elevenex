import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import * as express from 'express';
import { AgentGenerationModule } from '../agent-generation/agent-generation.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { KeytermService } from './keyterm.service.js';
import { SpeechCleanupController } from './speech-cleanup.controller.js';
import { SpeechToTextController } from './speech-to-text.controller.js';
import { SpeechToTextService } from './speech-to-text.service.js';
import { MAX_AUDIO_BYTES } from './speech-to-text.types.js';
import { TranscriptCleanupService } from './transcript-cleanup.service.js';

@Module({
  imports: [SettingsModule, AgentGenerationModule],
  controllers: [SpeechToTextController, SpeechCleanupController],
  providers: [SpeechToTextService, TranscriptCleanupService, KeytermService],
  exports: [SpeechToTextService],
})
export class SpeechToTextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Scoped to the audio controller only: the app-wide JSON body limit stays
    // at its default, nothing else in the API gains a 25 MB ceiling, and
    // `SpeechCleanupController` still receives a parsed JSON body.
    consumer
      .apply(express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }))
      .forRoutes(SpeechToTextController);
  }
}
