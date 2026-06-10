import { Injectable, Logger } from '@nestjs/common';
import { createRequire } from 'module';
import type {
  CanUseTool,
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildAugmentedEnvAsync, findBinary } from '../config/system-paths.js';
import { PiSessionRuntime } from '../pi-runtime/pi-session-runtime.js';

export type TextAgentProvider = 'claude' | 'codex' | 'pi';

export const DEFAULT_TEXT_AGENT_MODELS = {
  claude: 'haiku',
  codex: 'gpt-5.4-mini',
} as const;

type CodexSdkModule = typeof import('@openai/codex-sdk');

const importCodexSdk = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<CodexSdkModule>;

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
  };
  codex?: {
    model?: string;
  };
  pi?: {
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
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
        },
        tools: {
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
      const { Codex } = await importCodexSdk('@openai/codex-sdk');
      const codex = new Codex({
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

  private resolveSdkClaudePath(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidates =
      process.platform === 'linux'
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`,
          ];

    const scopedRequire = createRequire(__filename);
    for (const candidate of candidates) {
      try {
        return scopedRequire.resolve(candidate);
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private resolveClaudeCodeExecutable(): string {
    const configuredPath = process.env.ELEVENEX_CLAUDE_BIN?.trim();
    if (configuredPath) {
      return findBinary(configuredPath) ?? configuredPath;
    }

    return findBinary('claude') ?? this.resolveSdkClaudePath() ?? 'claude';
  }

  private toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
  }
}
