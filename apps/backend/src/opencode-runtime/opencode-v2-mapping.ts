import type {
  SessionInfo,
  SessionMessageInfo,
  ModelInfo,
  PermissionRequest as V2Permission,
  FormInfo,
  FormField,
} from '@opencode/client';
import type {
  Message,
  Part,
  Model,
  PermissionRequest,
  QuestionRequest,
  PermissionRuleset,
} from '@opencode-ai/sdk/v2/client';

export type OpenCodeFormRequest = QuestionRequest & {
  fields?: FormField[];
  title?: string;
};
export const v2Permissions = (rules?: PermissionRuleset) =>
  rules?.map((rule) => ({
    action:
      rule.permission === 'bash'
        ? 'shell'
        : rule.permission === 'task'
          ? 'subagent'
          : ['write', 'apply_patch', 'patch'].includes(rule.permission)
            ? 'edit'
            : rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
export const v2Session = (session: SessionInfo) => ({
  id: session.id,
  slug: session.id,
  projectID: session.projectID,
  directory: session.location.directory,
  version: '2',
  time: session.time,
  title: session.title ?? 'OpenCode session',
  parentID: session.parentID,
  revert: session.revert,
  agent: session.agent,
  model: session.model,
});

export function v2Model(model: ModelInfo): Model {
  const input = Object.fromEntries(
    ['text', 'image', 'audio', 'video', 'pdf'].map((type) => [
      type,
      model.capabilities.input.includes(type),
    ]),
  ) as Model['capabilities']['input'];
  const output = Object.fromEntries(
    ['text', 'image', 'audio', 'video', 'pdf'].map((type) => [
      type,
      model.capabilities.output.includes(type),
    ]),
  ) as Model['capabilities']['output'];
  return {
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    family: model.family,
    api: { id: model.modelID, url: '', npm: model.package ?? '' },
    capabilities: {
      temperature: false,
      reasoning: model.variants.length > 0,
      attachment: input.image,
      toolcall: model.capabilities.tools,
      input,
      output,
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: model.limit,
    status: model.status,
    options: {},
    headers: model.headers ?? {},
    release_date: new Date(model.time.released).toISOString(),
    variants: Object.fromEntries(
      model.variants.map((variant) => [variant.id, variant.settings ?? {}]),
    ),
  };
}

export function v2Message(
  sessionID: string,
  message: SessionMessageInfo,
): { info: Message; parts: Part[] } | null {
  const time = message.time;
  const base = { id: message.id, sessionID, time };
  if (message.type === 'user') {
    const info: Message = {
      ...base,
      role: 'user',
      agent: 'build',
      model: { providerID: '', modelID: '' },
    };
    const parts: Part[] = [
      {
        id: `${message.id}:text`,
        sessionID,
        messageID: message.id,
        type: 'text',
        text: message.text,
      },
    ];
    for (const [index, file] of (message.files ?? []).entries())
      parts.push({
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: 'file',
        mime: file.mime,
        url: `data:${file.mime};base64,${file.data}`,
        filename: file.name,
      });
    return { info, parts };
  }
  if (message.type === 'assistant') {
    const info: Message = {
      ...base,
      role: 'assistant',
      parentID: '',
      modelID: message.model.id,
      providerID: message.model.providerID,
      agent: message.agent,
      mode: message.agent,
      path: { cwd: '', root: '' },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...(message.error
        ? {
            error: {
              name: 'UnknownError' as const,
              data: { message: message.error.message },
            },
          }
        : {}),
    };
    const parts: Part[] = message.content.map((content, ordinal) => {
      const partBase = {
        id: `${message.id}:${ordinal}`,
        sessionID,
        messageID: message.id,
      };
      if (content.type === 'text')
        return { ...partBase, type: 'text', text: content.text };
      if (content.type === 'reasoning')
        return {
          ...partBase,
          type: 'reasoning',
          text: content.text,
          time: {
            start: content.time?.created ?? time.created,
            end: content.time?.completed,
          },
        };
      const toolBase = {
        ...partBase,
        id: content.id,
        type: 'tool' as const,
        callID: content.id,
        tool: content.name,
      };
      const state = content.state;
      if (state.status === 'streaming')
        return {
          ...toolBase,
          state: { status: 'pending', input: {}, raw: '' },
        };
      if (state.status === 'running')
        return {
          ...toolBase,
          state: {
            status: 'running',
            input: state.input,
            metadata: state.metadata,
            time: { start: content.time.ran ?? time.created },
          },
        };
      if (state.status === 'error')
        return {
          ...toolBase,
          state: {
            status: 'error',
            input: state.input,
            error: state.error.message,
            time: {
              start: content.time.ran ?? time.created,
              end: content.time.completed ?? time.created,
            },
          },
        };
      return {
        ...toolBase,
        state: {
          status: 'completed',
          input: state.input,
          title: content.name,
          output: state.content
            .map((item) =>
              item.type === 'text' ? item.text : JSON.stringify(item),
            )
            .join('\n'),
          metadata: state.metadata ?? {},
          time: {
            start: content.time.ran ?? time.created,
            end: content.time.completed ?? time.created,
          },
        },
      };
    });
    return { info, parts };
  }
  if (message.type === 'compaction') {
    return {
      info: {
        ...base,
        role: 'user',
        agent: 'build',
        model: { providerID: '', modelID: '' },
      },
      parts: [
        {
          id: `${message.id}:compaction`,
          sessionID,
          messageID: message.id,
          type: 'compaction',
          auto: true,
        },
      ],
    };
  }
  if (message.type === 'synthetic' || message.type === 'system') {
    return {
      info: {
        ...base,
        role: 'user',
        agent: 'build',
        model: { providerID: '', modelID: '' },
      },
      parts: [
        {
          id: `${message.id}:text`,
          sessionID,
          messageID: message.id,
          type: 'text',
          text: message.text,
          synthetic: true,
        },
      ],
    };
  }
  return null;
}

export function v2Permission(request: V2Permission): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action.replace(/^tool\./, ''),
    patterns: request.resources,
    always: request.save ?? [],
    metadata: request.metadata ?? {},
    tool: request.source
      ? { messageID: request.source.messageID, callID: request.source.id }
      : undefined,
  };
}
export function v2Form(form: FormInfo): OpenCodeFormRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    title: form.title,
    fields: form.fields,
    questions: [],
  };
}
