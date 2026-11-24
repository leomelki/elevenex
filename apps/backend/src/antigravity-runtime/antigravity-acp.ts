import type {
  AgentRuntimeProviderInfo,
  AgentTranscriptItem,
} from '../agent-runtime/agent-runtime.types.js';
import type {
  AgentToolKind,
  ClaudePermissionRequest,
} from '../claude-runtime/claude-runtime.types.js';
import { acpObject, type AcpStdio } from './acp-stdio.js';

export const ANTIGRAVITY_PROVIDER: AgentRuntimeProviderInfo = {
  id: 'antigravity',
  displayName: 'Antigravity',
  capabilities: {
    mcp: false,
    subagents: false,
    permissions: true,
    userInput: true,
    multimodalPrompts: true,
    terminalFallback: false,
    rewindConversation: false,
  },
};

export const ANTIGRAVITY_SIGN_IN =
  'Sign in with agy acp --login in a terminal on this machine, then send your message again.';
export const ANTIGRAVITY_INSTALL =
  'Install the official Antigravity CLI on this machine and make agy available on PATH.';
export const ANTIGRAVITY_CATALOG_SIGN_IN =
  'Sign in with agy acp --login on this machine, then refresh models.';

export async function initializeAntigravity(transport: AcpStdio) {
  const initialized = await transport.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'elevenex', title: 'Elevenex', version: '1' },
    clientCapabilities: { elicitation: { form: {} } },
  });
  if (initialized.protocolVersion !== 1)
    throw new Error(
      'This Antigravity CLI uses an unsupported ACP protocol version.',
    );
  return acpObject(initialized.agentCapabilities);
}

export function antigravityEnvironment(env: NodeJS.ProcessEnv) {
  const cliEnv = { ...env };
  // These capabilities belong to the desktop/backend connection, never the CLI.
  delete cliEnv.ELEVENEX_CODE_ACCESS;
  delete cliEnv.ELEVENEX_DESKTOP_SOCKET;
  return cliEnv;
}

type OptionValue = { id: string; displayName: string; description: string };
export interface AcpOption {
  configId: string;
  current: string;
  values: OptionValue[];
}

const executionModes = new Set(['default', 'accept-edits', 'auto', 'plan']);

export function acpText(value: unknown, limit = 1000): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

export function acpList(value: unknown, limit = 256): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

export function sessionOptions(result: Record<string, unknown>): {
  model?: AcpOption;
  thought?: AcpOption;
  mode?: AcpOption;
} {
  let model: AcpOption | undefined;
  let thought: AcpOption | undefined;
  let mode: AcpOption | undefined;
  for (const data of acpList(result.configOptions).map(acpObject)) {
    if (data.type !== 'select') continue;
    const configId = acpText(data.id);
    if (!configId) continue;
    const values = acpList(data.options)
      .flatMap((value) => {
        const option = acpObject(value);
        return Array.isArray(option.options)
          ? acpList(option.options)
          : [option];
      })
      .slice(0, 256)
      .map((value) => {
        const option = acpObject(value);
        const id = acpText(option.value);
        return {
          id,
          displayName: acpText(option.name) || id,
          description: acpText(option.description, 4000),
        };
      })
      .filter((option) => option.id);
    const option = { configId, current: acpText(data.currentValue), values };
    if (data.category === 'model' || configId === 'model') model = option;
    if (data.category === 'thought_level' || configId === 'thinking_level')
      thought = option;
    if (data.category === 'mode' || configId === 'mode') mode = option;
  }
  // Older ACP releases used models and session/set_model before config options.
  if (!model) {
    const models = acpObject(result.models);
    const values = acpList(models.availableModels)
      .map((value) => {
        const data = acpObject(value);
        const id = acpText(data.modelId);
        return {
          id,
          displayName: acpText(data.name) || id,
          description: acpText(data.description, 4000),
        };
      })
      .filter((option) => option.id);
    if (values.length)
      model = { configId: '', current: acpText(models.currentModelId), values };
  }
  // Some CLI versions advertise the same selector with the older modes field.
  if (!mode) {
    const modes = acpObject(result.modes);
    if (Array.isArray(modes.availableModes)) {
      mode = {
        configId: '',
        current: acpText(modes.currentModeId),
        values: acpList(modes.availableModes).map((value) => {
          const data = acpObject(value);
          const id = acpText(data.id);
          return {
            id,
            displayName: acpText(data.name) || id,
            description: acpText(data.description, 4000),
          };
        }),
      };
    }
  }
  if (mode) {
    const seen = new Set<string>();
    mode.values = mode.values.filter(({ id }) => {
      if (!executionModes.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return { model, thought, mode };
}

const toolKinds = new Map<string, AgentToolKind>([
  ['read', 'read'],
  ['edit', 'edit'],
  ['delete', 'edit'],
  ['move', 'edit'],
  ['search', 'grep'],
  ['execute', 'bash'],
  ['fetch', 'web_fetch'],
]);

export function acpTool(update: Record<string, unknown>) {
  const name = acpText(update.title) || 'Tool';
  const input = acpObject(update.rawInput);
  const path = acpText(acpObject(acpList(update.locations, 1)[0]).path, 4000);
  return {
    toolName: name,
    toolDisplayName: name,
    toolKind: toolKinds.get(acpText(update.kind)) ?? 'unknown',
    toolInput: {
      ...input,
      ...(path && !input.file_path ? { file_path: path } : {}),
    },
  };
}

export function acpPermission(
  requestId: string,
  toolUseId: string,
  update: Record<string, unknown>,
  allowAlways: boolean,
): ClaudePermissionRequest {
  const { toolInput, ...tool } = acpTool({
    ...update,
    rawInput: boundedToolData(update.rawInput),
  });
  return {
    ...tool,
    requestId,
    toolUseId,
    input: toolInput,
    suppressAlwaysAllowRule: !allowAlways,
    createdAt: new Date().toISOString(),
  };
}

const CONTENT_LIMIT = 512_000;
const ITEMS_LIMIT = 384;
const TURN_TEXT_LIMIT = 1_500_000;
const TOOL_DATA_LIMIT = 8_000;

function boundedToolData(value: unknown): unknown {
  if (value === undefined) return;
  const json = JSON.stringify(value);
  return json.length <= TOOL_DATA_LIMIT
    ? value
    : { preview: json.slice(0, TOOL_DATA_LIMIT) };
}

/** Projects each active turn once, without replaying native history or re-keying chunks. */
export class AntigravityTurn {
  readonly items: AgentTranscriptItem[];
  private textLength = 0;
  private readonly tools = new Map<
    string,
    { index: number; update: Record<string, unknown>; result?: number }
  >();

  constructor(
    readonly id: string,
    prompt: AgentTranscriptItem,
  ) {
    this.items = [prompt];
  }

  toolId(native: string): string {
    return `${this.id}:tool:${native}`;
  }

  update(update: Record<string, unknown>): boolean {
    const type = update.sessionUpdate;
    const kind =
      type === 'agent_message_chunk'
        ? 'assistant'
        : type === 'agent_thought_chunk'
          ? 'thinking'
          : null;
    if (kind) {
      const content = acpObject(update.content);
      if (content.type !== 'text') return false;
      const last = this.items.at(-1);
      const previous = last?.kind === kind ? (last.content ?? '') : '';
      const text = acpText(
        content.text,
        Math.min(
          CONTENT_LIMIT - previous.length,
          TURN_TEXT_LIMIT - this.textLength,
        ),
      );
      if (!text) return false;
      if (last?.kind === kind) {
        this.items[this.items.length - 1] = {
          ...last,
          content: previous + text,
        };
        this.textLength += text.length;
        return true;
      }
      if (this.items.length >= ITEMS_LIMIT) return false;
      this.textLength += text.length;
      this.items.push({
        kind,
        id: `${this.id}:${this.items.length}`,
        content: text,
        timestamp: new Date().toISOString(),
      });
      return true;
    }
    if (type !== 'tool_call' && type !== 'tool_call_update') return false;
    const nativeId = acpText(update.toolCallId, 256);
    if (!nativeId) return false;
    let tool = this.tools.get(nativeId);
    if (!tool && this.items.length >= ITEMS_LIMIT) return false;
    const toolId = this.toolId(nativeId);
    const timestamp = new Date().toISOString();
    const { title, kind: toolKind, status, locations, rawInput } = update;
    const boundedUpdate = {
      ...(typeof title === 'string' ? { title: acpText(title) } : {}),
      ...(typeof toolKind === 'string' ? { kind: acpText(toolKind) } : {}),
      ...(typeof status === 'string' ? { status: acpText(status) } : {}),
      ...(locations
        ? {
            locations: acpList(locations, 1).map((location) => ({
              path: acpText(acpObject(location).path, 4000),
            })),
          }
        : {}),
      ...(rawInput !== undefined
        ? { rawInput: boundedToolData(rawInput) }
        : {}),
    };
    if (!tool) {
      tool = { index: this.items.length, update: {} };
      this.tools.set(nativeId, tool);
      this.items.push({
        id: toolId,
        toolUseId: toolId,
        kind: 'tool_use',
        timestamp,
      });
    }
    Object.assign(tool.update, boundedUpdate);
    const details = acpTool(tool.update);
    this.items[tool.index] = { ...this.items[tool.index], ...details };
    if (tool.update.status === 'completed' || tool.update.status === 'failed') {
      if (tool.result === undefined && this.items.length >= ITEMS_LIMIT)
        return true;
      const output = acpList(update.content, 32)
        .map(acpObject)
        .map((item) => {
          if (item.type === 'diff') return acpText(item.path, 4000);
          const content = acpObject(item.content);
          return acpText(content.text, TOOL_DATA_LIMIT);
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, TOOL_DATA_LIMIT);
      const previous =
        tool.result === undefined ? undefined : this.items[tool.result];
      const result: AgentTranscriptItem = {
        toolName: details.toolName,
        toolKind: details.toolKind,
        toolDisplayName: details.toolDisplayName,
        id: `${toolId}:result`,
        toolUseId: toolId,
        kind: 'tool_result',
        timestamp: previous?.timestamp ?? timestamp,
        content: output || previous?.content,
        providerToolResult:
          update.rawOutput === undefined
            ? previous?.providerToolResult
            : boundedToolData(update.rawOutput),
        isError: tool.update.status === 'failed',
      };
      if (tool.result === undefined) {
        tool.result = this.items.length;
        this.items.push(result);
      } else this.items[tool.result] = result;
    }
    return true;
  }
}
