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
import { buildAntigravitySpawnCommand } from '../antigravity-runtime/antigravity-binary.js';

const execFileAsync = promisify(execFileCallback);

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
   * Runs a one-shot, read-only Antigravity turn via `agy -p ... --output-format
   * json`. These flows want a single block of text, not a conversation, so
   * this uses `agy`'s headless print mode rather than the stream-json session
   * machinery the workspace runtime needs. Read-only by construction (no
   * `--dangerously-skip-permissions`): unapproved tool calls are soft-denied
   * per `agy`'s default policy, which is exactly what a text-generation task
   * wants.
   *
   * The exact `--output-format json` envelope shape is not confirmed against
   * a live install — see docs/antigravity-provider-flow.md — so
   * `parseAntigravityEnvelope` scans defensively the same way the old Gemini
   * parser did, rather than assuming a fixed shape.
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
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'json',
      ...(model ? ['--model', model] : []),
    ];

    try {
      const { command, shell } = buildAntigravitySpawnCommand();
      const env = await buildAugmentedEnvAsync(
        process.env,
        request.worktreePath,
      );
      const { stdout } = await execFileAsync(command, args, {
        cwd: request.worktreePath,
        env,
        shell,
        timeout: request.antigravity?.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });

      const envelope = this.parseAntigravityEnvelope(stdout);
      if (!envelope) {
        this.logger.warn(
          `[${request.taskName}] Antigravity returned no parseable JSON output`,
        );
        return null;
      }
      if (envelope.error) {
        this.logger.warn(
          `[${request.taskName}] Antigravity query failed: ${envelope.error}`,
        );
        return null;
      }
      return { provider: 'antigravity', model, text: envelope.response ?? '' };
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Antigravity query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Extracts `agy -p --output-format json`'s result envelope from stdout,
   * which can be preceded by unstructured startup noise. Looks for the first
   * and last top-level `{` on stdout as candidate parses rather than assuming
   * a fixed prefix, since the exact envelope shape is unconfirmed.
   */
  private parseAntigravityEnvelope(
    stdout: string,
  ): { response?: string; error?: string } | null {
    const trimmed = stdout.trim();
    const candidates = [trimmed];
    const firstBrace = trimmed.indexOf('{');
    if (firstBrace > 0) candidates.push(trimmed.slice(firstBrace));
    const lastBrace = stdout.lastIndexOf('\n{');
    if (lastBrace >= 0) candidates.push(stdout.slice(lastBrace + 1).trim());

    for (const candidate of candidates) {
      if (!candidate.startsWith('{')) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (!parsed || typeof parsed !== 'object') continue;
        const record = parsed as Record<string, unknown>;
        const error = record['error'];
        const errorMessage =
          typeof error === 'string'
            ? error
            : error && typeof error === 'object'
              ? String((error as Record<string, unknown>)['message'] ?? 'unknown')
              : record['status'] === 'ERROR'
                ? 'Antigravity turn failed.'
                : undefined;
        const response =
          typeof record['response'] === 'string'
            ? record['response']
            : typeof record['text'] === 'string'
              ? record['text']
              : undefined;
        return {
          response,
          ...(errorMessage ? { error: errorMessage } : {}),
        };
      } catch {
        continue;
      }
    }
    return null;
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
