import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_TEXT_AGENT_MODELS,
  TextAgentGenerationService,
  type TextAgentProvider,
} from '../agent-generation/text-agent-generation.service.js';
import type { DefaultAgentProvider } from '../settings/settings.types.js';

/**
 * Dictation is interactive, so a slow cleanup is worse than no cleanup. The
 * frontend shows the raw transcript immediately and swaps in the cleaned text
 * when it arrives, but we still cap the wait so a wedged CLI cannot leave a
 * request hanging.
 */
const CLEANUP_TIMEOUT_MS = 8_000;

/** Long dictations are rare; past this the latency is not worth it. */
const MAX_CLEANUP_CHARS = 4_000;

const SYSTEM_PROMPT =
  'You clean up dictated text for a software engineer. You only ever reply with the corrected text.';

export interface CleanupRequest {
  rawText: string;
  provider: DefaultAgentProvider;
  model: string | null;
  worktreePath: string;
  /** File and symbol names from the session, used to fix spoken identifiers. */
  keyterms: string[];
}

@Injectable()
export class TranscriptCleanupService {
  private readonly logger = new Logger(TranscriptCleanupService.name);

  constructor(
    private readonly textAgentGenerationService: TextAgentGenerationService,
  ) {}

  /**
   * Returns the tidied transcript, or `null` if cleanup was skipped or failed.
   * Never throws: the caller falls back to the raw transcript, because losing
   * dictated words to a cleanup error would be far worse than leaving in a
   * stray "um".
   */
  async clean(request: CleanupRequest): Promise<string | null> {
    const raw = request.rawText.trim();
    if (!raw || raw.length > MAX_CLEANUP_CHARS) {
      return null;
    }

    const provider = this.normalizeProvider(request.provider);
    if (!provider) {
      this.logger.warn(
        `Transcript cleanup skipped, unsupported provider=${request.provider}`,
      );
      return null;
    }

    const model = request.model ?? defaultModelFor(provider);
    const prompt = this.buildPrompt(raw, request.keyterms);
    const startedAt = Date.now();

    try {
      const result = await this.withTimeout(
        this.textAgentGenerationService.generate({
          provider,
          worktreePath: request.worktreePath,
          prompt,
          taskName: 'speech-cleanup',
          claude: {
            ...(model ? { model } : {}),
            maxTurns: 1,
            persistSession: false,
            systemPrompt: SYSTEM_PROMPT,
            // No tool schemas: this is a pure text transform and sending the
            // full claude_code preset would slow a latency-critical call.
            tools: [],
          },
          ...(model ? { codex: { model } } : {}),
          ...(model ? { antigravity: { model } } : {}),
        }),
        CLEANUP_TIMEOUT_MS,
      );

      const cleaned = this.normalizeReply(result?.text ?? '');
      if (!cleaned) {
        this.logger.warn(
          `Transcript cleanup returned nothing usable provider=${provider} elapsedMs=${Date.now() - startedAt}`,
        );
        return null;
      }

      // A model that "helpfully" rewrites the request instead of transcribing
      // it produces wildly different length. Treat that as a failed cleanup.
      if (cleaned.length > raw.length * 2 + 40) {
        this.logger.warn(
          `Transcript cleanup rejected, reply too long rawLength=${raw.length} cleanedLength=${cleaned.length}`,
        );
        return null;
      }

      this.logger.log(
        `Transcript cleaned provider=${provider} model=${JSON.stringify(result?.model ?? model)} elapsedMs=${Date.now() - startedAt} rawLength=${raw.length} cleanedLength=${cleaned.length}`,
      );
      return cleaned;
    } catch (error) {
      this.logger.warn(
        `Transcript cleanup failed provider=${provider} elapsedMs=${Date.now() - startedAt} error=${(error as Error).message}`,
      );
      return null;
    }
  }

  private buildPrompt(raw: string, keyterms: string[]): string {
    const lines = [
      'Clean up this dictated message so it reads as the user intended to write it.',
      '',
      'Rules:',
      '- Remove filler words and false starts ("um", "uh", "you know", "I mean").',
      '- Fix punctuation, casing and obvious speech-recognition errors.',
      '- Reconstruct code identifiers that were spoken aloud. For example "cw dash composer dot component dot ts" becomes cw-composer.component.ts, and "use effect" in a React context becomes useEffect.',
      '- Convert spoken punctuation to symbols when clearly intended ("open paren", "new line").',
      '- Keep the original meaning, wording and language. Do not answer the message, summarise it, or add anything.',
      '- Reply with only the cleaned text.',
    ];

    if (keyterms.length > 0) {
      lines.push(
        '',
        'Names from the current repository, for spelling reference:',
        keyterms.slice(0, 120).join(', '),
      );
    }

    lines.push('', 'Dictated text:', raw);
    return lines.join('\n');
  }

  /** Models tend to wrap short answers in quotes or a code fence. */
  private normalizeReply(input: string): string {
    let text = input.trim();

    const fenced = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(text);
    if (fenced) {
      text = fenced[1]!.trim();
    }

    const quoted = /^"([\s\S]*)"$/.exec(text);
    if (quoted && !quoted[1]!.includes('"')) {
      text = quoted[1]!;
    }

    return text.trim();
  }

  private normalizeProvider(
    provider: DefaultAgentProvider,
  ): TextAgentProvider | null {
    return provider === 'claude' ||
      provider === 'codex' ||
      provider === 'pi' ||
      provider === 'antigravity'
      ? provider
      : null;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function defaultModelFor(provider: TextAgentProvider): string | null {
  return provider === 'claude' || provider === 'codex'
    ? DEFAULT_TEXT_AGENT_MODELS[provider]
    : null;
}
