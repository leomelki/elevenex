import { OpenCodeServer } from '../opencode-runtime/opencode-server.js';
import { openCodeModel } from '../opencode-runtime/opencode-transcript.js';
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  CanUseTool,
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  buildAugmentedEnvAsync,
  buildSpawnCommand,
  findBinary,
} from '../config/system-paths.js';
import { resolveCodexBinary } from '../codex-runtime/codex-binary.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';
import { SettingsService } from '../settings/settings.service.js';

export type TextAgentProvider = 'claude' | 'codex' | 'pi' | 'opencode';

export const DEFAULT_TEXT_GENERATION_TIMEOUT_MS = 60_000;

/** Races even startup/cleanup APIs that do not implement AbortSignal themselves. */
function withCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Attach both handlers immediately, including when already cancelled. A late
    // provider failure must never become an unhandled rejection.
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export function readCodexExecAgentMessage(line: string): string | null {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      item?: { type?: unknown; text?: unknown };
    };
    return event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
      ? event.item.text
      : null;
  } catch {
    return null;
  }
}

export function readCodexExecError(line: string): string | null {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      message?: unknown;
      error?: { message?: unknown };
    };
    if (event.type !== 'error' && event.type !== 'turn.failed') return null;
    if (typeof event.message === 'string') return event.message;
    return typeof event.error?.message === 'string'
      ? event.error.message
      : null;
  } catch {
    return null;
  }
}

export interface GenerateTextWithAgentRequest {
  provider: TextAgentProvider;
  worktreePath: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  taskName: string;
  /** Overall deadline, including provider startup and cleanup. Defaults to 60s. */
  timeoutMs?: number;
  signal?: AbortSignal;
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
  opencode?: { model?: string; timeoutMs?: number };
  pi?: {
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

  constructor(private readonly settingsService: SettingsService) {}

  async generate(
    request: GenerateTextWithAgentRequest,
  ): Promise<GenerateTextWithAgentResult | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const requestedTimeout =
      request.timeoutMs ??
      (request.provider === 'pi'
        ? request.pi?.timeoutMs
        : request.provider === 'opencode'
          ? request.opencode?.timeoutMs
          : undefined);
    const timeoutMs =
      requestedTimeout !== undefined &&
      Number.isFinite(requestedTimeout) &&
      requestedTimeout >= 0
        ? requestedTimeout
        : DEFAULT_TEXT_GENERATION_TIMEOUT_MS;
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Text generation timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      switch (request.provider) {
        case 'claude':
          return await this.generateWithClaude(request, controller);
        case 'codex':
          return await this.generateWithCodex(request, controller.signal);
        case 'opencode':
          return await this.generateWithOpenCode(request, controller.signal);
        case 'pi':
          return await this.generateWithPi(
            request,
            controller.signal,
            timeoutMs,
          );
      }
      return null;
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] ${request.provider} generation failed: ${String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async generateWithOpenCode(
    request: GenerateTextWithAgentRequest,
    signal: AbortSignal,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') return null;
    const model = this.resolveModel('opencode', request.opencode?.model);
    const server = new OpenCodeServer({
      cwd: request.worktreePath,
      config: { permission: { '*': 'deny' } },
    });
    let sessionID: string | undefined;
    let client: Awaited<ReturnType<OpenCodeServer['start']>> | undefined;
    try {
      client = await withCancellation(server.start(), signal);
      signal.throwIfAborted();
      sessionID = (
        await withCancellation(
          client.session.create(
            {
              title: `Elevenex ${request.taskName}`,
              permission: [{ permission: '*', pattern: '*', action: 'deny' }],
            },
            { signal },
          ),
          signal,
        )
      ).data!.id;
      signal.throwIfAborted();
      const result = (
        await withCancellation(
          client.session.prompt(
            {
              sessionID,
              model: openCodeModel(model),
              parts: [{ type: 'text', text: request.prompt }],
              system:
                'Return only the requested text. Do not use tools or modify files.',
            },
            { signal },
          ),
          signal,
        )
      ).data;
      if (!result || result.info.error) return null;
      const text = result.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
      return text ? { provider: 'opencode', model, text } : null;
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] OpenCode generation failed: ${String(error)}`,
      );
      return null;
    } finally {
      if (sessionID && client && !signal.aborted) {
        try {
          await withCancellation(
            client.session.delete({ sessionID }, { signal }),
            signal,
          );
        } catch {
          // Cleanup is bounded too, but cannot fail a completed generation.
        }
      }
      server.close();
    }
  }

  private async generateWithClaude(
    request: GenerateTextWithAgentRequest,
    controller: AbortController,
  ): Promise<GenerateTextWithAgentResult | null> {
    const signal = controller.signal;
    const sdk = await withCancellation(this.loadClaudeSdk(), signal);
    if (!sdk) {
      this.logger.warn(`[${request.taskName}] Claude SDK not available`);
      return null;
    }

    const model = this.resolveModel('claude', request.claude?.model);
    const env = await withCancellation(
      buildAugmentedEnvAsync(process.env, request.worktreePath),
      signal,
    );
    signal.throwIfAborted();
    const canUseTool =
      request.claude?.canUseTool ??
      (async () => ({
        behavior: 'deny' as const,
        message: 'Tool use disabled',
      }));

    const runtimeQuery = sdk.query({
      prompt: request.prompt,
      options: {
        abortController: controller,
        cwd: request.worktreePath,
        ...(model ? { model } : {}),
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
      await withCancellation(
        (async () => {
          for await (const message of runtimeQuery) {
            if (message.type === 'assistant') {
              assistantText += this.extractClaudeAssistantText(message);
            }
            if (message.type === 'result') {
              break;
            }
          }
        })(),
        signal,
      );
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
    signal: AbortSignal,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') {
      this.logger.warn(
        `[${request.taskName}] Codex generation requires a string prompt`,
      );
      return null;
    }

    const model = this.resolveModel('codex', request.codex?.model);
    try {
      const env = await withCancellation(
        buildAugmentedEnvAsync(process.env, request.worktreePath),
        signal,
      );
      signal.throwIfAborted();
      const text = await this.runCodexExec(
        request.worktreePath,
        request.prompt,
        model,
        env,
        signal,
      );
      return {
        provider: 'codex',
        model,
        text,
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

  /**
   * Runs the user-visible Codex CLI instead of reaching into any package
   * manager's installation tree. buildSpawnCommand handles native binaries,
   * Windows command shims, and POSIX launchers through the same interface used
   * by interactive Codex sessions.
   */
  private runCodexExec(
    worktreePath: string,
    prompt: string,
    model: string | null,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const { command, shell } = buildSpawnCommand(resolveCodexBinary());
      const args = [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '-c',
        'approval_policy="never"',
        '-c',
        'model_reasoning_effort="low"',
        ...(model ? ['--model', model] : []),
        '-',
      ];
      const child = spawn(command, args, {
        cwd: worktreePath,
        env,
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      let finalResponse = '';
      let protocolError = '';
      let stderr = '';
      let settled = false;
      let closed = false;
      let killTimer: NodeJS.Timeout | undefined;

      const onLine = (line: string) => {
        const message = readCodexExecAgentMessage(line);
        if (message !== null) finalResponse = message;
        const error = readCodexExecError(line);
        if (error !== null) protocolError = error;
      };
      const onStderr = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-32_768);
      };
      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
        lines.off('line', onLine);
        lines.close();
        lines.off('error', fail);
        child.stderr.off('data', onStderr);
        child.off('error', fail);
        child.stdin.off('error', fail);
        child.stdout.off('error', fail);
        child.stderr.off('error', fail);
        child.off('close', onClose);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        lines.close();
        reject(error);
        // Keep error handlers until the pipes close; killing a child can race
        // an EPIPE from its pending stdin write. Escalate even if SIGTERM was sent.
        killTimer = setTimeout(() => {
          try {
            if (!closed) child.kill('SIGKILL');
          } catch {
            /* Already gone. */
          }
          cleanup();
        }, 1_500);
        killTimer.unref();
        try {
          child.kill('SIGTERM');
        } catch {
          /* Already gone. */
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const onAbort = () => fail(signal.reason);
      const onClose = (
        code: number | null,
        exitSignal: NodeJS.Signals | null,
      ) => {
        closed = true;
        cleanup();
        if (settled) return;
        settled = true;
        if (code === 0 && !protocolError) {
          resolve(finalResponse);
          return;
        }
        reject(
          new Error(
            protocolError ||
              stderr.trim() ||
              `Codex exited with code ${code ?? 'null'} and signal ${exitSignal ?? 'null'}`,
          ),
        );
      };
      lines.on('line', onLine);
      lines.on('error', fail);
      child.stderr.on('data', onStderr);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      // close follows stdio end, so readline can consume the final JSONL line,
      // including output without a trailing newline. exit is too early.
      child.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        child.stdin.end(prompt);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async generateWithPi(
    request: GenerateTextWithAgentRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<GenerateTextWithAgentResult | null> {
    if (typeof request.prompt !== 'string') {
      this.logger.warn(
        `[${request.taskName}] Pi generation requires a string prompt`,
      );
      return null;
    }

    const model = this.resolveModel('pi', request.pi?.model);
    const runtime = new PiSessionRuntime({
      cwd: request.worktreePath,
      timeoutMs,
    });
    const sending = new AbortController();
    const sendSignal = AbortSignal.any([signal, sending.signal]);
    let assistantDeltaText = '';
    let assistantFinalText = '';
    let cleanupCompletion = () => {};

    const completionPromise = new Promise<void>((resolve, reject) => {
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
        runtime.off('event', onEvent);
        runtime.off('exit', onExit);
      };

      runtime.on('event', onEvent);
      runtime.on('exit', onExit);
    });

    try {
      // Observe completion immediately: Pi can emit error/exit before an RPC
      // send acknowledges. Promise.all also releases us if that send hangs.
      await withCancellation(
        Promise.all([
          completionPromise,
          (async () => {
            const parsedModel = this.parsePiModelRef(model);
            if (parsedModel) {
              await withCancellation(
                runtime.send({
                  type: 'set_model',
                  provider: parsedModel.provider,
                  modelId: parsedModel.modelId,
                }),
                sendSignal,
              );
            } else if (model) {
              this.logger.warn(
                `[${request.taskName}] Ignoring invalid Pi model reference: ${JSON.stringify(model)}`,
              );
            }
            sendSignal.throwIfAborted();
            await withCancellation(
              runtime.send({
                type: 'prompt',
                message: request.prompt,
                reasoningEffort: 'low',
              }),
              sendSignal,
            );
          })(),
        ]),
        signal,
      );
      return {
        provider: 'pi',
        model,
        text: assistantFinalText || assistantDeltaText,
      };
    } catch (error) {
      this.logger.warn(
        `[${request.taskName}] Pi query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      cleanupCompletion();
      sending.abort();
      await withCancellation(runtime.stop(), signal).catch(() => undefined);
    }
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

  private resolveModel(
    provider: TextAgentProvider,
    requestedModel?: string,
  ): string | null {
    const requested = requestedModel?.trim();
    if (requested) return requested;
    return this.settingsService.getAgentProviderDefaults(provider).model;
  }

  private parsePiModelRef(
    model: string | null,
  ): { provider: string; modelId: string } | null {
    if (!model) return null;
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) return null;
    return {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    };
  }

  private resolveClaudeCodeExecutable(): string {
    const configuredPath = process.env.ELEVENEX_CLAUDE_BIN?.trim();
    if (configuredPath) {
      return findBinary(configuredPath) ?? configuredPath;
    }

    return findBinary('claude') ?? 'claude';
  }
}
