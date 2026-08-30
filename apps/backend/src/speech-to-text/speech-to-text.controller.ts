import { BadRequestException, Controller, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SpeechToTextService } from './speech-to-text.service.js';
import { TranscribeQueryDto } from './dto/transcribe.dto.js';

/**
 * Audio-carrying routes only. Kept separate from `SpeechCleanupController`
 * because `SpeechToTextModule` binds an `express.raw` body parser to this
 * controller, which would turn a JSON body into a Buffer.
 */
@Controller('speech-to-text')
export class SpeechToTextController {
  constructor(private readonly speechToTextService: SpeechToTextService) {}

  /**
   * The recording arrives as a raw body rather than JSON or multipart: it is
   * already a compact binary blob, base64 would inflate it by a third, and the
   * `Content-Type` header carries the codec the browser chose.
   */
  @Post('transcribe')
  transcribe(@Req() request: Request, @Query() query: TranscribeQueryDto) {
    return this.speechToTextService.transcribe({
      audio: readAudioBody(request),
      mimeType: request.headers['content-type'] ?? 'application/octet-stream',
      sessionId: query.sessionId ?? null,
      worktreePath: query.worktreePath ?? null,
    });
  }

  /** Settings "test microphone" round trip. Same pipeline, no session context. */
  @Post('test')
  test(@Req() request: Request, @Query() query: TranscribeQueryDto) {
    return this.speechToTextService.transcribe({
      audio: readAudioBody(request),
      mimeType: request.headers['content-type'] ?? 'application/octet-stream',
      sessionId: null,
      worktreePath: query.worktreePath ?? null,
    });
  }
}

function readAudioBody(request: Request): Buffer {
  const body: unknown = request.body;
  if (!Buffer.isBuffer(body)) {
    throw new BadRequestException(
      'Expected a raw audio body. Send the recording as the request body with its audio Content-Type.',
    );
  }
  return body;
}
