import type { OpenCodeFormRequest } from './opencode-v2-mapping.js';
import type {
  Message,
  Part,
  PermissionRequest,
  PermissionRuleset,
} from '@opencode-ai/sdk/v2/client';
import type {
  ClaudeTranscriptItem,
  ClaudePermissionRequest,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';

export function openCodePartItems(
  part: Part,
  message?: Message,
): ClaudeTranscriptItem[] {
  const timestamp = new Date(
    (part.type === 'tool' && 'time' in part.state ? part.state.time.start : undefined) ?? message?.time.created ??
      ('time' in part && part.time && 'start' in part.time
        ? part.time.start
        : undefined) ??
      Date.now(),
  ).toISOString();
  const base = {
    id: part.id,
    sourceMessageId: part.messageID,
    transcriptMessageId: part.messageID,
    timestamp,
  };
  if (part.type === 'text' || part.type === 'reasoning') {
    if (part.type === 'text' && part.ignored) return [];
    // OpenCode delivers background results as synthetic user parts in a new
    // native turn. Keep them in the originating work timeline in the desktop.
    if (part.type === 'text' && part.synthetic && message?.role === 'user') {
      const task = openCodeTaskOutput(part.text);
      if (task && task.status !== 'running') return [{
        ...base, kind: 'system', nativeTask: task,
        content: task.detail || (task.status === 'error' ? 'Agent failed.' : 'Agent finished.'),
        isSynthetic: true, isError: task.status === 'error',
      }];
    }
    return [
      {
        ...base,
        kind:
          part.type === 'reasoning'
            ? 'thinking'
            : message?.role === 'user'
              ? 'user'
              : 'assistant',
        content: part.text,
        ...(part.type === 'text' &&
        message?.role === 'assistant' &&
        message.agent === 'plan'
          ? { contentType: 'plan' as const }
          : {}),
        ...(part.type === 'text' ? { isSynthetic: part.synthetic } : {}),
      },
    ];
  }
  if (
    part.type === 'file' &&
    /^data:image\/(png|jpeg|gif|webp);base64,/.test(part.url)
  ) {
    const [header, data] = part.url.split(',');
    return [
      {
        ...base,
        kind: message?.role === 'user' ? 'user' : 'assistant',
        images: [{ mediaType: header.slice(5, -7) as 'image/png', data }],
      },
    ];
  }
  if (part.type === 'tool') {
    const canonical = canonicalizeAgentTool(part.tool, part.state.input);
    const nativeTask = part.tool === 'task' ? openCodeTask(part.state) : undefined;
    const tool = {
      ...base,
      ...canonical,
      toolUseId: part.callID,
      toolName: canonical.toolDisplayName,
      providerToolName: part.tool,
      providerToolInput: part.state.input,
      ...(nativeTask ? { nativeTask } : {}),
    };
    const items: ClaudeTranscriptItem[] = [{ ...tool, kind: 'tool_use' }];
    if (part.state.status === 'completed' || part.state.status === 'error') {
      items.push({
        ...tool,
        id: `${part.id}:result`,
        kind: 'tool_result',
        content:
          part.state.status === 'error' ? part.state.error : part.state.output,
        isError: part.state.status === 'error',
        timestamp: Number.isFinite(part.state.time.end) ? new Date(part.state.time.end).toISOString() : timestamp,
      });
    }
    return items;
  }
  if (part.type === 'compaction')
    return [
      {
        ...base,
        kind: 'system',
        content: 'OpenCode compacted the conversation context.',
      },
    ];
  return [];
}

function openCodeTaskOutput(output: string): ClaudeTranscriptItem['nativeTask'] {
  const tag = /^<task id="(ses_[\w-]{1,252})" state="(running|completed|error)">\r?\n/.exec(output);
  if (!tag) return;
  const status = tag[2] === 'error' ? 'error' : tag[2] === 'completed' ? 'completed' : 'running';
  const detail = status === 'running' ? undefined :
    /<task_(?:result|error)>\s*([\s\S]*?)\s*<\/task_(?:result|error)>/.exec(output)?.[1];
  return { agentId: tag[1], provider: 'opencode', status, detail: detail?.slice(0, 720) };
}

function openCodeTask(state: Extract<Part, { type: 'tool' }>['state']): ClaudeTranscriptItem['nativeTask'] {
  const metadata = 'metadata' in state ? state.metadata : undefined;
  const output = state.status === 'completed' ? state.output : state.status === 'error' ? state.error : '';
  const notification = openCodeTaskOutput(output);
  const legacy = /^task_id:\s*(ses_[\w-]+)/.exec(output);
  const agentId = metadata?.sessionId ?? metadata?.sessionID ?? notification?.agentId ?? legacy?.[1] ?? state.input.task_id;
  if (typeof agentId !== 'string' || !/^ses_[\w-]+$/.test(agentId) || agentId.length > 256) return;
  const model = metadata?.model;
  const providerID: unknown = model && typeof model === 'object' && 'providerID' in model ? model.providerID : undefined;
  const modelID: unknown = model && typeof model === 'object' && 'modelID' in model ? model.modelID : undefined;
  const status = state.status === 'error' ? 'error' : notification?.status ??
    (state.status !== 'completed' || metadata?.background === true ? 'running' : 'completed');
  const detail = status !== 'running' && output
    ? (notification?.detail ?? output.replace(/^task_id:[^\n]*\n+/, '')).slice(0, 720)
    : undefined;
  return {
    agentId, provider: 'opencode', status, detail,
    ...(typeof providerID === 'string' && typeof modelID === 'string' ? { model: providerID + '/' + modelID } : {}),
  };
}

export function openCodePermission(
  request: PermissionRequest,
): ClaudePermissionRequest {
  const canonical = canonicalizeAgentTool(request.permission, request.metadata);
  return {
    requestId: request.id,
    toolUseId: request.tool?.callID ?? request.id,
    toolName: canonical.toolDisplayName,
    providerToolName: request.permission,
    ...canonical,
    input: canonical.toolInput,
    providerInput: request.metadata,
    description: request.patterns.join('\n'),
    createdAt: new Date().toISOString(),
  };
}

export function openCodeQuestion(
  request: OpenCodeFormRequest,
): ClaudeUserInputRequest {
  if (request.fields) {
    const external = request.fields.find((field) => field.type === 'external');
    const fields = request.fields.filter(
      (field) => field.type !== 'external' && !field.hidden,
    );
    return {
      requestId: request.id,
      serverName: 'OpenCode',
      message: request.title ?? 'OpenCode needs your input.',
      createdAt: new Date().toISOString(),
      ...(external && external.type === 'external'
        ? { mode: 'url', url: external.url }
        : {}),
      requestedSchema: {
        type: 'object',
        required: fields
          .filter((field) => 'required' in field && field.required)
          .map((field) => field.key),
        properties: Object.fromEntries(
          fields.map((field) => [
            field.key,
            {
              ...field,
              type: field.type === 'multiselect' ? 'array' : field.type,
              ...('options' in field && field.options
                ? field.type === 'multiselect'
                  ? {
                      items: {
                        type: 'string',
                        enum: field.options.map((option) => option.value),
                      },
                    }
                  : { enum: field.options.map((option) => option.value) }
                : {}),
            },
          ]),
        ),
      },
    };
  }
  return {
    requestId: request.id,
    serverName: 'OpenCode',
    message: 'OpenCode needs your input.',
    createdAt: new Date().toISOString(),
    questions: request.questions.map((question, index) => ({
      id: String(index),
      question: question.question,
      header: question.header,
      options: question.options,
      multiSelect: question.multiple,
    })),
  };
}

/** Explicit user-selected policies override project defaults only for this session. */
export function openCodePermissionRules(
  mode: string | null,
): PermissionRuleset | undefined {
  if (!mode || mode === 'default') return undefined;
  const rules: PermissionRuleset = [
    {
      permission: '*',
      pattern: '*',
      action:
        mode === 'bypassPermissions'
          ? 'allow'
          : mode === 'dontAsk'
            ? 'deny'
            : 'ask',
    },
  ];
  if (mode === 'acceptEdits' || mode === 'auto') {
    for (const permission of [
      'read',
      'glob',
      'grep',
      'list',
      'edit',
      'write',
      'apply_patch',
      'todowrite',
      'todoread',
    ])
      rules.push({ permission, pattern: '*', action: 'allow' });
  }
  return rules;
}

export function openCodeModel(
  model: string | null,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator < 1 || separator === model.length - 1)
    throw new Error('OpenCode model IDs must use provider/model format.');
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}
