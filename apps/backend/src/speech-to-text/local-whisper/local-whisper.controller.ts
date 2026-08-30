import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable, from, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import type { LocalWhisperModelId } from '../../settings/settings.types.js';
import { LocalWhisperService } from './local-whisper.service.js';
import type { LocalWhisperStatus } from './local-whisper.types.js';
import { isLocalWhisperModelId } from './whisper-catalog.js';

interface LocalWhisperStreamEvent {
  type: 'status';
  data: LocalWhisperStatus;
}

/**
 * Model management for the offline engine. Separate from
 * `SpeechToTextController` because that one has a raw body parser bound to it,
 * which would turn these JSON responses' requests into Buffers.
 */
@Controller('speech-to-text/local-models')
export class LocalWhisperController {
  constructor(private readonly localWhisper: LocalWhisperService) {}

  @Get()
  getStatus(): Promise<LocalWhisperStatus> {
    return this.localWhisper.getStatus();
  }

  /**
   * Status snapshots while a download runs. The first event is the current
   * state, so a page opened mid-download renders a filled bar immediately
   * rather than waiting for the next chunk.
   */
  @Sse('stream')
  stream(): Observable<LocalWhisperStreamEvent> {
    const toEvent = map(
      (data: LocalWhisperStatus): LocalWhisperStreamEvent => ({
        type: 'status',
        data,
      }),
    );

    return merge(
      from(this.localWhisper.getStatus()).pipe(toEvent),
      this.localWhisper.changes.pipe(toEvent),
    );
  }

  /**
   * Starts a download and returns immediately: these run for minutes, and the
   * job outlives the request so navigating away cannot cancel it. Progress
   * arrives on `stream`.
   */
  @Post(':model/download')
  async startDownload(
    @Param('model') model: string,
  ): Promise<LocalWhisperStatus> {
    this.localWhisper.download(this.assertModel(model));
    return this.localWhisper.getStatus();
  }

  @Post(':model/cancel')
  async cancelDownload(
    @Param('model') model: string,
  ): Promise<LocalWhisperStatus> {
    await this.localWhisper.cancelDownload(this.assertModel(model));
    return this.localWhisper.getStatus();
  }

  @Delete(':model')
  async remove(@Param('model') model: string): Promise<LocalWhisperStatus> {
    await this.localWhisper.remove(this.assertModel(model));
    return this.localWhisper.getStatus();
  }

  private assertModel(model: string): LocalWhisperModelId {
    if (!isLocalWhisperModelId(model)) {
      throw new BadRequestException(`Unknown Whisper model: ${model}.`);
    }
    return model;
  }
}
