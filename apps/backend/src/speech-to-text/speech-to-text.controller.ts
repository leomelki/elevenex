import {
  BadRequestException,
  Controller,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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
  transcribe(
    @Req() request: Request,
    @Query() query: TranscribeQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transcribeRequest(request, response, query);
  }

  /** Settings "test microphone" round trip. Same pipeline, no session context. */
  @Post('test')
  test(
    @Req() request: Request,
    @Query() query: TranscribeQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.transcribeRequest(request, response, {
      ...query,
      sessionId: undefined,
    });
  }

  private async transcribeRequest(
    request: Request,
    response: Response,
    query: TranscribeQueryDto,
  ) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const onClose = () => {
      if (!response.writableEnded) onAbort();
    };
    request.once('aborted', onAbort);
    response.once('close', onClose);
    if (request.aborted || (response.destroyed && !response.writableEnded)) {
      onAbort();
    }
    try {
      return await this.speechToTextService.transcribe({
        audio: readAudioBody(request),
        mimeType: request.headers['content-type'] ?? 'application/octet-stream',
        sessionId: query.sessionId ?? null,
        worktreePath: query.worktreePath ?? null,
        signal: controller.signal,
      });
    } finally {
      request.removeListener('aborted', onAbort);
      response.removeListener('close', onClose);
    }
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
