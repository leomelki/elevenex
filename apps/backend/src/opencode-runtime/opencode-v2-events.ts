import type {
  OpenCodeClient as NativeClient,
  V2Event,
  FormInfo,
} from '@opencode/client';
import type {
  Event,
  Message,
  Part,
  ToolPart,
  QuestionAnswer,
} from '@opencode-ai/sdk/v2/client';
import type { OpenCodeMessage } from './opencode-transcript-store.js';
import {
  v2Form,
  v2Message,
  v2Permission,
  v2Session,
} from './opencode-v2-mapping.js';

/** Normalizes native live events and seeds in-flight blocks when recovering a snapshot. */
export class OpenCodeV2Events {
  readonly forms = new Map<string, FormInfo>();
  readonly permissionOwners = new Map<string, string>();
  private readonly assistants = new Map<
    string,
    Message & { role: 'assistant' }
  >();
  private readonly tools = new Map<string, ToolPart>();

  constructor(
    private readonly native: NativeClient,
    private readonly directory: string,
  ) {}

  hydrate(messages: OpenCodeMessage[]): void {
    for (const { info, parts } of messages) {
      if (info.role === 'assistant') {
        if (info.time.completed) this.assistants.delete(info.id);
        else if (!this.assistants.has(info.id))
          this.assistants.set(info.id, info);
      }
      for (const part of parts)
        if (
          part.type === 'tool' &&
          (part.state.status === 'pending' || part.state.status === 'running')
        ) {
          if (!this.tools.has(part.id)) this.tools.set(part.id, part);
        } else if (part.type === 'tool') this.tools.delete(part.id);
    }
  }

  private async recoverMessage(
    sessionID: string,
    messageID: string,
  ): Promise<OpenCodeMessage | null> {
    try {
      return v2Message(
        sessionID,
        await this.native.session.message.get({ sessionID, messageID }),
      );
    } catch {
      // A deleted message cannot be recovered; the provider's next snapshot remains authoritative.
      return null;
    }
  }
  private async tool(
    sessionID: string,
    messageID: string,
    id: string,
  ): Promise<ToolPart | undefined> {
    return (
      this.tools.get(id) ??
      (await this.recoverMessage(sessionID, messageID))?.parts.find(
        (part): part is ToolPart => part.type === 'tool' && part.id === id,
      )
    );
  }
  private async assistant(
    sessionID: string,
    messageID: string,
  ): Promise<(Message & { role: 'assistant' }) | undefined> {
    const cached = this.assistants.get(messageID);
    if (cached) return cached;
    const recovered = (await this.recoverMessage(sessionID, messageID))?.info;
    return recovered?.role === 'assistant' ? recovered : undefined;
  }

  async *stream(
    stream: AsyncIterable<V2Event>,
  ): AsyncGenerator<Event, void, unknown> {
    for await (const event of stream) {
      switch (event.type) {
        case 'server.connected':
          yield { id: event.id, type: 'server.connected', properties: {} };
          break;
        case 'session.agent.selected':
        case 'session.model.selected':
          yield {
            id: event.id,
            type: 'session.updated',
            properties: {
              sessionID: event.data.sessionID,
              info: v2Session(
                await this.native.session.get({
                  sessionID: event.data.sessionID,
                }),
              ),
            },
          };
          break;
        case 'session.created': {
          const data = event.data;
          yield {
            id: event.id,
            type: 'session.created',
            properties: {
              sessionID: event.data.sessionID,
              info: {
                id: data.sessionID,
                parentID: data.parentID,
                title: data.title ?? '',
                projectID: data.projectID,
                slug: data.slug,
                directory: data.location.directory,
                version: data.version,
                time: { created: event.created, updated: event.created },
              },
            },
          };
          break;
        }
        case 'session.step.started': {
          const data = event.data;
          const info: Message & { role: 'assistant' } = {
            id: data.assistantMessageID,
            sessionID: data.sessionID,
            role: 'assistant',
            time: { created: data.started },
            parentID: '',
            modelID: data.model.id,
            providerID: data.model.providerID,
            agent: data.agent,
            mode: data.agent,
            path: { cwd: this.directory, root: this.directory },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          };
          this.assistants.set(info.id, info);
          yield {
            id: event.id,
            type: 'message.updated',
            properties: { sessionID: info.sessionID, info },
          };
          break;
        }
        case 'session.text.started':
        case 'session.reasoning.started': {
          const data = event.data;
          const base = {
            id: `${data.assistantMessageID}:${data.ordinal}`,
            sessionID: data.sessionID,
            messageID: data.assistantMessageID,
            text: '',
          };
          const part: Part =
            event.type === 'session.text.started'
              ? { ...base, type: 'text' }
              : { ...base, type: 'reasoning', time: { start: event.created } };
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: part.sessionID,
              time: event.created,
              part,
            },
          };
          break;
        }
        case 'session.text.delta':
        case 'session.reasoning.delta': {
          const data = event.data;
          yield {
            id: event.id,
            type: 'message.part.delta',
            properties: {
              sessionID: data.sessionID,
              messageID: data.assistantMessageID,
              partID: `${data.assistantMessageID}:${data.ordinal}`,
              field: 'text',
              delta: data.delta,
            },
          };
          break;
        }
        case 'session.text.ended':
        case 'session.reasoning.ended': {
          const data = event.data;
          const base = {
            id: `${data.assistantMessageID}:${data.ordinal}`,
            sessionID: data.sessionID,
            messageID: data.assistantMessageID,
            text: data.text,
          };
          const part: Part =
            event.type === 'session.text.ended'
              ? { ...base, type: 'text' }
              : {
                  ...base,
                  type: 'reasoning',
                  time: { start: event.created, end: event.created },
                };
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: part.sessionID,
              time: event.created,
              part,
            },
          };
          break;
        }
        case 'session.tool.input.started': {
          const data = event.data;
          const part: ToolPart = {
            id: data.id,
            sessionID: data.sessionID,
            messageID: data.assistantMessageID,
            type: 'tool',
            callID: data.id,
            tool: data.name,
            state: { status: 'pending', input: {}, raw: '' },
          };
          this.tools.set(part.id, part);
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: part.sessionID,
              time: event.created,
              part,
            },
          };
          break;
        }
        case 'session.tool.called': {
          const part = await this.tool(
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.id,
          );
          if (!part) break;
          const updated: ToolPart = {
            ...part,
            state: {
              status: 'running',
              input: event.data.input,
              time: { start: event.created },
            },
          };
          this.tools.set(part.id, updated);
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: updated.sessionID,
              time: event.created,
              part: updated,
            },
          };
          break;
        }
        case 'session.tool.success':
        case 'session.tool.failed': {
          const data = event.data;
          const part = await this.tool(
            data.sessionID,
            data.assistantMessageID,
            data.id,
          );
          if (!part) break;
          const time = {
            start: 'time' in part.state ? part.state.time.start : event.created,
            end: event.created,
          };
          const updated: ToolPart = {
            ...part,
            state:
              event.type === 'session.tool.failed'
                ? {
                    status: 'error',
                    input: part.state.input,
                    error: event.data.error.message,
                    time,
                  }
                : {
                    status: 'completed',
                    input: part.state.input,
                    output: event.data.content
                      .map((item) =>
                        item.type === 'text' ? item.text : JSON.stringify(item),
                      )
                      .join('\n'),
                    title: part.tool,
                    metadata: event.data.metadata ?? {},
                    time,
                  },
          };
          this.tools.delete(part.id);
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: updated.sessionID,
              time: event.created,
              part: updated,
            },
          };
          break;
        }
        case 'session.tool.progress': {
          const data = event.data;
          const part = await this.tool(
            data.sessionID,
            data.assistantMessageID,
            data.id,
          );
          if (!part || part.state.status !== 'running') break;
          const updated: ToolPart = {
            ...part,
            state: { ...part.state, metadata: data.metadata },
          };
          this.tools.set(part.id, updated);
          yield {
            id: event.id,
            type: 'message.part.updated',
            properties: {
              sessionID: data.sessionID,
              time: event.created,
              part: updated,
            },
          };
          break;
        }
        case 'session.step.failed':
        case 'session.step.ended': {
          const info = await this.assistant(
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (!info) break;
          const updated = {
            ...info,
            tokens: event.data.tokens ?? info.tokens,
            cost: event.data.cost ?? info.cost,
            time: { ...info.time, completed: event.created },
            ...(event.type === 'session.step.failed'
              ? {
                  error: {
                    name: 'UnknownError' as const,
                    data: { message: event.data.error.message },
                  },
                }
              : {}),
          };
          this.assistants.delete(info.id);
          yield {
            id: event.id,
            type: 'message.updated',
            properties: { sessionID: event.data.sessionID, info: updated },
          };
          break;
        }
        case 'permission.asked':
          this.permissionOwners.set(event.data.id, event.data.sessionID);
          yield {
            id: event.id,
            type: 'permission.asked',
            properties: v2Permission(event.data),
          };
          break;
        case 'permission.replied':
          this.permissionOwners.delete(event.data.requestID);
          yield {
            id: event.id,
            type: 'permission.replied',
            properties: event.data,
          };
          break;
        case 'form.created':
          this.forms.set(event.data.form.id, event.data.form);
          yield {
            id: event.id,
            type: 'question.asked',
            properties: v2Form(event.data.form),
          };
          break;
        case 'form.replied':
          this.forms.delete(event.data.id);
          yield {
            id: event.id,
            type: 'question.replied',
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers: [] as QuestionAnswer[],
            },
          };
          break;
        case 'form.cancelled':
          this.forms.delete(event.data.id);
          yield {
            id: event.id,
            type: 'question.rejected',
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
            },
          };
          break;
        case 'session.retry.scheduled':
          yield {
            id: event.id,
            type: 'session.status',
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: 'retry',
                attempt: event.data.attempt,
                message: event.data.error.message,
                next: event.data.at,
              },
            },
          };
          break;
        case 'session.status':
          yield {
            id: event.id,
            type: 'session.status',
            properties: event.data,
          };
          break;
        case 'session.idle':
          for (const [id, info] of this.assistants)
            if (info.sessionID === event.data.sessionID)
              this.assistants.delete(id);
          for (const [id, part] of this.tools)
            if (part.sessionID === event.data.sessionID) this.tools.delete(id);
          yield {
            id: event.id,
            type: 'session.status',
            properties: {
              sessionID: event.data.sessionID,
              status: { type: 'idle' },
            },
          };
          break;
        case 'session.execution.failed':
          yield {
            id: event.id,
            type: 'session.error',
            properties: {
              sessionID: event.data.sessionID,
              error: {
                name: 'UnknownError',
                data: { message: event.data.error.message },
              },
            },
          };
          break;
        case 'session.compaction.ended':
          yield {
            id: event.id,
            type: 'session.compacted',
            properties: { sessionID: event.data.sessionID },
          };
          break;
        default:
          break;
      }
    }
  }
}
