import { Injectable, Logger } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  CanUseTool,
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildAugmentedEnvAsync, findBinary } from '../config/system-paths.js';
import {
  findSdkRealDir,
  resolveCodexBinary,
} from '../codex-runtime/codex-binary.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';
import { AntigravityProcessClient } from '../antigravity-runtime/antigravity-process-client.js';
import type { AntigravityResultEvent } from '../antigravity-runtime/antigravity-runtime.types.js';

const execFileAsync = promisify(execFileCallback);

/**
 * These one-shot flows run without `--dangerously-skip-permissions`, so `agy`
 * auto-denies every tool call — and a denied call ends the turn with an empty
 * response rather than an error. Telling the model up front to answer from the
 * prompt is what keeps it from spending the turn on a tool it cannot use.
 */
const ANTIGRAVITY_NO_TOOLS_PREAMBLE =
  'Do not use any tools. Do not run commands and do not read files. ' +
  'Everything you need is in this message; answer directly from it.';

export type TextAgentProvider = 'claude' | 'codex' | 'pi' | 'antigravity';

export const DEFAULT_TEXT_AGENT_MODELS = {
  claude: 'haiku',
  codex: 'gpt-5.4-mini',
} as const;

type CodexSdkModule = typeof import('@openai/codex-sdk');

const _dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<CodexSdkModule>;

async function importCodexSdk(): Promise<CodexSdkModule> {
  // In the bundled runtime, `import('@openai/codex-sdk')` resolves relative to
  // main.cjs which has no node_modules sibling. Resolve the SDK to an absolute
  // file URL so Node can find it regardless of where main.cjs lives.
  const sdkDir = findSdkRealDir();
  if (sdkDir) {
    const entryPoint = path.join(sdkDir, 'dist', 'index.js');
    if (existsSync(entryPoint)) {
      return _dynamicImport(pathToFileURL(entryPoint).href);
    }
  }
  return _dynamicImport('@openai/codex-sdk');
}

export interface GenerateTextWithAgentRequest {
  provider: TextAgentProvider;
  worktreePath: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  taskName: string;
  claude?: {
    model?: string;
    maxTurns?: number;
    persistSession?: boolean;
    settingSources?: Array<'user' | 'project' | 'local'>;
    allowedTools?: string[];
    canUseTool?: CanUseTool;
    /**
     * Custom system prompt. Defaults to the full `claude_code` preset prompt.
     * Pass a short string to skip that preset entirely for cheap, one-shot
     * tasks that don't need Claude Code's assistant persona or tool-use
     * instructions.
     */
    systemPrompt?: string;
    /**
     * Built-in tool set. Defaults to the full `claude_code` preset (every
     * tool schema sent with the request). Pass `[]` to send no tool schemas
     * at all for tasks that never use tools.
     */
    tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  };
  codex?: {
    model?: string;
  };
  pi?: {
    timeoutMs?: number;
  };
  antigravity?: {
    /** Omitted by default so Antigravity uses whatever model the account defaults to. */
    model?: string;
    timeoutMs?: number;
    /**
     * JSON schema enforced on the final result (`agy --json-schema`). When
     * set, `agy` also returns a parsed `structured_output` object, which is
     * far more reliable than scraping the prose response.
     */
    jsonSchema?: Record<string, unknown>;
  };
}

export interface GenerateTextWithAgentResult {
  provider: TextAgentProvider;
  model: string | null;
  text: string;
}

@Injectable()
export class TextAgentGenerationService {
  private readonly logger = new Logger(TextAgentGenerationService.name);

  async generate(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    switch (request.provider) {
      case 'claude':
        return this.generateWithClaude(request);
      case 'codex':
        return this.generateWithCodex(request);
      case 'pi':
        return this.generateWithPi(request);
      case 'antigravity':
        return this.generateWithAntigravity(request);
    }
  }

  private async generateWithClaude(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    const sdk = await this.loadClaudeSdk();
    if (!sdk) {
      this.logger.warn(`[${request.taskName}] Claude SDK not available`);
      return null;
    }

    const model = request.claude?.model ?? DEFAULT_TEXT_AGENT_MODELS.claude;
    const env = await buildAugmentedEnvAsync(process.env, request.worktreePath);
    const canUseTool =
      request.claude?.canUseTool ??
      (async () => ({
        behavior: 'deny' as const,
        message: 'Tool use disabled',
      }));

    const runtimeQuery = sdk.query({
      prompt: request.prompt,
      options: {
        cwd: request.worktreePath,
        model,
        permissionMode: 'plan',
        canUseTool,
        ...(request.claude?.maxTurns !== undefined
          ? { maxTurns: request.claude.maxTurns }
          : {}),
        ...(request.claude?.persistSession !== undefined
          ? { persistSession: request.claude.persistSession }
          : {}),
        ...(request.claude?.settingSources
          ? { settingSources: request.claude.settingSources }
          : {}),
        ...(request.claude?.allowedTools
          ? { allowedTools: request.claude.allowedTools }
          : {}),
        pathToClaudeCodeExecutable: this.resolveClaudeCodeExecutable(),
        systemPrompt: request.claude?.systemPrompt ?? {
          type: 'preset' as const,
          preset: 'claude_code' as const,
        },
        tools: request.claude?.tools ?? {
          type: 'preset' as const,
          preset: 'claude_code' as const,
        },
        env,
      },
    });

    let assistantText = '';
    try {
      for await (const message of runtimeQuery) {
        if (message.type === 'assistant') {
          assistantText += this.extractClaudeAssistantText(message);
        }
        if (message.type === 'result') {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Claude query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      runtimeQuery.close();
    }

    return { provider: 'claude', model, text: assistantText };
  }

  private async generateWithCodex(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') {
      this.logger.warn(
        `[${request.taskName}] Codex generation requires a string prompt`,
      );
      return null;
    }

    const model = request.codex?.model ?? DEFAULT_TEXT_AGENT_MODELS.codex;
    try {
      const env = await buildAugmentedEnvAsync(
        process.env,
        request.worktreePath,
      );
      const { Codex } = await importCodexSdk();
      const codex = new Codex({
        codexPathOverride: resolveCodexBinary(),
        env: this.toStringEnv(env),
      });
      const thread = codex.startThread({
        workingDirectory: request.worktreePath,
        skipGitRepoCheck: true,
        model,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      });
      const result = await thread.run(request.prompt);
      return {
        provider: 'codex',
        model,
        text: result.finalResponse ?? '',
      };
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Codex query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async generateWithPi(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') {
      this.logger.warn(
        `[${request.taskName}] Pi generation requires a string prompt`,
      );
      return null;
    }

    const timeoutMs = request.pi?.timeoutMs ?? 60_000;
    const runtime = new PiSessionRuntime({
      cwd: request.worktreePath,
      timeoutMs,
    });
    let assistantDeltaText = '';
    let assistantFinalText = '';
    let cleanupCompletion = () => {};

    const completionPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupCompletion();
        reject(new Error('Pi text generation timed out.'));
      }, timeoutMs);

      const onEvent = (event: Record<string, unknown>) => {
        if (event.type === 'agent_end') {
          cleanupCompletion();
          resolve();
          return;
        }
        if (event.type === 'error') {
          cleanupCompletion();
          reject(new Error(String(event.message ?? 'Pi runtime error')));
          return;
        }
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined;
          if (
            update?.type === 'text_delta' &&
            typeof update.delta === 'string'
          ) {
            assistantDeltaText += update.delta;
          }
          return;
        }
        if (event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined;
          if (message?.role === 'assistant') {
            const text = this.extractPiMessageText(message);
            if (text) assistantFinalText = text;
          }
        }
      };

      const onExit = (details: { message?: string; stderr?: string }) => {
        cleanupCompletion();
        reject(
          new Error(
            details.stderr?.trim() ||
              details.message ||
              'Pi RPC process exited.',
          ),
        );
      };

      cleanupCompletion = () => {
        clearTimeout(timer);
        runtime.off('event', onEvent);
        runtime.off('exit', onExit);
      };

      runtime.on('event', onEvent);
      runtime.on('exit', onExit);
    });

    try {
      await runtime.send({
        type: 'prompt',
        message: request.prompt,
      });
      await completionPromise;
      return {
        provider: 'pi',
        model: null,
        text: assistantFinalText || assistantDeltaText,
      };
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Pi query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      cleanupCompletion();
      return null;
    } finally {
      await runtime.stop().catch(() => undefined);
    }
  }

  /**
   * Runs a one-shot, read-only Antigravity turn.
   *
   * This drives `agy`'s stream-json session protocol rather than its `-p`
   * print mode, even though the flows here want a single block of text.
   * Print mode only accepts the prompt as a command-line argument (it does
   * not read stdin), and these prompts embed a diff plus convention docs —
   * on Windows that blows past the ~32k command-line limit and the spawn
   * fails outright with `ENAMETOOLONG`, which is what made commit-message
   * generation fail on any non-trivial change. The stream protocol takes the
   * prompt as one NDJSON line on stdin, so prompt size is a non-issue.
   *
   * Read-only by construction: no `--dangerously-skip-permissions`, so `agy`
   * auto-denies any tool call. Because a denied tool ends the turn with an
   * empty response, the prompt is prefixed with an explicit instruction to
   * answer directly instead of reaching for tools.
   */
  private async generateWithAntigravity(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') {
      this.logger.warn(
        `[${request.taskName}] Antigravity generation requires a string prompt`,
      );
      return null;
    }

    const model = request.antigravity?.model ?? null;
    const schema = request.antigravity?.jsonSchema;
    const timeoutMs = request.antigravity?.timeoutMs ?? 120_000;

    const client = new AntigravityProcessClient({
      cwd: request.worktreePath,
      extraArgs: [
        // `agy` does not treat its process cwd as the workspace; without this
        // it works out of an empty scratch directory and can see no repo
        // context at all.
        '--add-dir',
        request.worktreePath,
        // Prompts embed raw diffs and file contents; without this a line
        // starting with `/` is expanded as a slash command.
        '--disable-slash-commands',
        ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
        ...(model ? ['--model', model] : []),
      ],
    });

    try {
      await client.start();
      const result = await this.withTimeout(
        client.prompt(`${ANTIGRAVITY_NO_TOOLS_PREAMBLE}\n\n${request.prompt}`),
        timeoutMs,
        `Antigravity turn exceeded ${timeoutMs}ms`,
      );

      if (result.status === 'ERROR' || result.status === 'INVALID') {
        this.logger.warn(
          `[${request.taskName}] Antigravity query failed: ${
            result.error || result.status
          }`,
        );
        return null;
      }

      const text = this.readAntigravityText(result);
      // A turn whose tool calls were all auto-denied still reports SUCCESS,
      // but with an empty response. Returning '' here would look like a parse
      // failure to callers; name the real cause instead.
      if (!text.trim()) {
        const stderr = client.getStderr().trim();
        this.logger.warn(
          `[${request.taskName}] Antigravity returned an empty response ` +
            `(status=${result.status}, stderr: ${stderr || 'none'}). This ` +
            'usually means the model called a tool and headless mode ' +
            'auto-denied it.',
        );
        return null;
      }
      return { provider: 'antigravity', model, text };
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Antigravity query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  /**
   * Reads a turn's text, preferring the schema-validated object.
   *
   * With `--json-schema`, `agy` returns the validated object in
   * `structured_output` while `response` keeps the model's raw prose
   * (markdown fences, restated JSON, trailing tool chatter), so the
   * structured form is what callers should parse.
   */
  private readAntigravityText(result: AntigravityResultEvent): string {
    const structured = (result as unknown as Record<string, unknown>)[
      'structured_output'
    ];
    if (structured && typeof structured === 'object') {
      return JSON.stringify(structured);
    }
    return result.response ?? '';
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async loadClaudeSdk(): Promise<{
    query: (typeof import('@anthropic-ai/claude-agent-sdk'))['query'];
  } | null> {
    try {
      return await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return null;
    }
  }

  private extractClaudeAssistantText(message: SDKAssistantMessage): string {
    const content = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  private extractPiMessageText(message: Record<string, unknown>): string {
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .map((part) => {
        if (
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'text' &&
          typeof (part as Record<string, unknown>).text === 'string'
        ) {
          return (part as Record<string, string>).text;
        }
        return '';
      })
      .join('');
  }

  private resolveClaudeCodeExecutable(): string {
    const configuredPath = process.env.ELEVENEX_CLAUDE_BIN?.trim();
    if (configuredPath) {
      return findBinary(configuredPath) ?? configuredPath;
    }

    return findBinary('claude') ?? 'claude';
  }

  private toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
  }
}
