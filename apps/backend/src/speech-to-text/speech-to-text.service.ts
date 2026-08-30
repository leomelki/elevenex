import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  SettingsService,
  type ResolvedSpeechToTextConfig,
} from '../settings/settings.service.js';
import {
  DEFAULT_AGENT_PROVIDERS,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_SPEECH_TO_TEXT_MODELS,
  type DefaultAgentProvider,
} from '../settings/settings.types.js';
import { KeytermService } from './keyterm.service.js';
import { ElevenLabsSpeechToTextProvider } from './providers/elevenlabs.provider.js';
import { OpenAiCompatibleSpeechToTextProvider } from './providers/openai-compatible.provider.js';
import { OpenRouterSpeechToTextProvider } from './providers/openrouter.provider.js';
import {
  MAX_AUDIO_BYTES,
  SpeechToTextProvider,
  SpeechToTextProviderError,
  TranscriptionResult,
  baseMimeType,
} from './speech-to-text.types.js';
import { TranscriptCleanupService } from './transcript-cleanup.service.js';

export interface TranscribeRequest {
  audio: Buffer;
  mimeType: string;
  sessionId: number | null;
  worktreePath: string | null;
}

export interface CleanupRequestInput {
  text: string;
  sessionId: number | null;
  worktreePath: string | null;
}

export interface CleanupResponse {
  text: string;
  applied: boolean;
  elapsedMs: number;
}

@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly settingsService: SettingsService,
    private readonly keytermService: KeytermService,
    private readonly cleanupService: TranscriptCleanupService,
  ) {}

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    if (request.audio.byteLength === 0) {
      throw new BadRequestException('No audio was recorded.');
    }
    if (request.audio.byteLength > MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        `Recording is too large (${Math.round(request.audio.byteLength / 1024 / 1024)} MB). Keep dictations under ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
      );
    }

    const config = await this.settingsService.getSpeechToTextConfig();
    if (!config.enabled) {
      throw new BadRequestException(
        'Dictation is turned off. Enable it in Settings.',
      );
    }
    if (!config.apiKey) {
      throw new BadRequestException(
        'No dictation API key is configured. Add one in Settings.',
      );
    }

    const provider = this.buildProvider(config, config.apiKey);
    const mimeType = baseMimeType(request.mimeType);
    if (!provider.acceptedMimeTypes.includes(mimeType)) {
      // Defence in depth: the client already converts for providers that need
      // it, so reaching here means a bug or a hand-crafted request.
      throw new BadRequestException(
        `${config.provider} cannot accept ${mimeType} audio.`,
      );
    }

    const session = await this.loadSession(request.sessionId);
    const worktreePath = request.worktreePath ?? session?.worktreePath ?? null;
    const model = config.model ?? DEFAULT_SPEECH_TO_TEXT_MODELS[config.provider];

    const keyterms = config.keytermsEnabled
      ? await this.keytermService.collect(
          worktreePath,
          session?.branchName ?? null,
        )
      : [];

    const startedAt = Date.now();
    let rawText: string;
    try {
      rawText = await provider.transcribe({
        audio: request.audio,
        mimeType: request.mimeType,
        model,
        language: config.language,
        keyterms,
      });
    } catch (error) {
      if (error instanceof SpeechToTextProviderError) {
        this.logger.warn(
          `Transcription failed provider=${config.provider} model=${model} status=${error.status ?? 'n/a'} message=${error.message}`,
        );
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    const transcribeMs = Date.now() - startedAt;

    this.logger.log(
      `Transcribed provider=${config.provider} model=${model} bytes=${request.audio.byteLength} mimeType=${mimeType} keyterms=${keyterms.length} elapsedMs=${transcribeMs} textLength=${rawText.length}`,
    );

    return {
      text: rawText,
      provider: config.provider,
      model,
      transcribeMs,
      /** Tells the client whether a follow-up cleanup call is worth making. */
      cleanupAvailable: config.cleanupMode !== 'off',
    };
  }

  /**
   * Second half of dictation, deliberately a separate call: the client shows
   * the raw transcript the moment it lands and swaps in the cleaned text when
   * this returns, so an opt-in cleanup model never delays the words appearing.
   *
   * Returns the input unchanged with `applied: false` whenever cleanup is off,
   * unavailable, or fails — dictated words are never lost to a cleanup error.
   */
  async cleanup(request: CleanupRequestInput): Promise<CleanupResponse> {
    const startedAt = Date.now();
    const unchanged = (): CleanupResponse => ({
      text: request.text,
      applied: false,
      elapsedMs: Date.now() - startedAt,
    });

    const config = await this.settingsService.getSpeechToTextConfig();
    if (config.cleanupMode === 'off' || !request.text.trim()) {
      return unchanged();
    }

    const session = await this.loadSession(request.sessionId);
    const worktreePath = request.worktreePath ?? session?.worktreePath ?? null;
    if (!worktreePath) {
      // Every agent harness runs inside a worktree; without one there is
      // nothing to run the cleanup model in.
      return unchanged();
    }

    const provider =
      config.cleanupMode === 'session-harness'
        ? this.asAgentProvider(session?.activeAgentProvider)
        : config.cleanupProvider;
    if (!provider) {
      return unchanged();
    }

    const model =
      config.cleanupMode === 'session-harness'
        ? this.settingsService.getAgentProviderDefaults(provider).model
        : config.cleanupModel;

    const keyterms = config.keytermsEnabled
      ? await this.keytermService.collect(
          worktreePath,
          session?.branchName ?? null,
        )
      : [];

    const text = await this.cleanupService.clean({
      rawText: request.text,
      provider,
      model,
      worktreePath,
      keyterms,
    });

    return text === null
      ? unchanged()
      : { text, applied: true, elapsedMs: Date.now() - startedAt };
  }

  private buildProvider(
    config: ResolvedSpeechToTextConfig,
    apiKey: string,
  ): SpeechToTextProvider {
    switch (config.provider) {
      case 'elevenlabs':
        return new ElevenLabsSpeechToTextProvider(apiKey);
      case 'openai-compatible':
        return new OpenAiCompatibleSpeechToTextProvider(
          apiKey,
          config.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        );
      case 'openrouter':
        return new OpenRouterSpeechToTextProvider(apiKey);
      default:
        throw new BadRequestException(
          `Unsupported speech-to-text provider: ${String(config.provider)}`,
        );
    }
  }

  private async loadSession(sessionId: number | null) {
    if (sessionId === null || !Number.isInteger(sessionId)) {
      return null;
    }
    const rows = await this.db
      .select({
        worktreePath: schema.sessions.worktreePath,
        branchName: schema.sessions.branchName,
        activeAgentProvider: schema.sessions.activeAgentProvider,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  private asAgentProvider(
    value: string | undefined,
  ): DefaultAgentProvider | null {
    return DEFAULT_AGENT_PROVIDERS.includes(value as DefaultAgentProvider)
      ? (value as DefaultAgentProvider)
      : null;
  }
}
