import { Body, Controller, Post } from '@nestjs/common';
import { CleanupTranscriptDto } from './dto/cleanup-transcript.dto.js';
import { SpeechToTextService } from './speech-to-text.service.js';

/**
 * Deliberately a separate controller from `SpeechToTextController`: that one
 * has a raw body parser bound to it for audio uploads, which would stop this
 * JSON body from being parsed.
 */
@Controller('speech-to-text')
export class SpeechCleanupController {
  constructor(private readonly speechToTextService: SpeechToTextService) {}

  @Post('cleanup')
  cleanup(@Body() dto: CleanupTranscriptDto) {
    return this.speechToTextService.cleanup({
      text: dto.text,
      sessionId: dto.sessionId ?? null,
      worktreePath: dto.worktreePath ?? null,
    });
  }
}
