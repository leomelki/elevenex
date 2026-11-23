import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ClaudePermissionRequest,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import { acpObject } from './acp-stdio.js';
import { acpList, acpPermission, acpText } from './antigravity-acp.js';

export type AntigravityAnswer = Record<
  string,
  string | number | boolean | string[]
>;
type Decision =
  | {
      kind: 'permission';
      view: ClaudePermissionRequest;
      options: Map<string, string>;
      resolve(value: unknown): void;
    }
  | {
      kind: 'question';
      view: ClaudeUserInputRequest;
      resolve(value: unknown): void;
    };

const PERMISSION_CANCELLED = { outcome: { outcome: 'cancelled' } };
const QUESTION_CANCELLED = { action: 'cancel' };

function permissionOutcome(optionId?: string) {
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : PERMISSION_CANCELLED;
}

/** Serializes native requests through the single visible desktop decision card. */
export class AntigravityDecisions {
  private readonly pending: Decision[] = [];

  constructor(private readonly changed: () => void) {}

  get current(): Decision | undefined {
    return this.pending[0];
  }

  receive(
    method: string,
    params: Record<string, unknown>,
    toolId?: (nativeId: string) => string,
  ): unknown {
    const permission = method === 'session/request_permission';
    if (
      !permission &&
      method !== 'elicitation/create' &&
      method !== 'session/elicitation'
    )
      return;
    if (!toolId || this.pending.length >= 16)
      return permission ? PERMISSION_CANCELLED : QUESTION_CANCELLED;

    const requestId = randomUUID();
    if (permission) {
      const tool = acpObject(params.toolCall);
      const nativeId = acpText(tool.toolCallId, 256);
      const options = new Map<string, string>();
      for (const value of acpList(params.options, 16)) {
        const option = acpObject(value);
        if (
          typeof option.kind === 'string' &&
          typeof option.optionId === 'string' &&
          option.optionId.length > 0 &&
          option.optionId.length <= 1000
        )
          options.set(option.kind, option.optionId);
      }
      if (!nativeId || !options.has('allow_once'))
        return permissionOutcome(options.get('reject_once'));
      const view = acpPermission(
        requestId,
        toolId(nativeId),
        tool,
        options.has('allow_always'),
      );
      return new Promise((resolve) => {
        this.pending.push({ kind: 'permission', view, options, resolve });
        this.changed();
      });
    }

    const schema = acpObject(params.requestedSchema);
    if (
      params.mode === 'url' ||
      schema.type !== 'object' ||
      Object.keys(acpObject(schema.properties)).length > 20 ||
      JSON.stringify(schema).length > 24_000
    )
      return { action: 'decline' };
    return new Promise((resolve) => {
      this.pending.push({
        kind: 'question',
        resolve,
        view: {
          requestId,
          serverName: 'Antigravity',
          message: acpText(params.message, 4000),
          mode: 'form',
          requestedSchema: schema,
          createdAt: new Date().toISOString(),
        },
      });
      this.changed();
    });
  }

  permission(
    requestId: string,
    kind: 'allow_once' | 'allow_always' | 'reject_once',
  ): void {
    const request = this.current;
    if (request?.kind !== 'permission' || request.view.requestId !== requestId)
      throw new ConflictException(
        'This Antigravity permission is no longer pending.',
      );
    const optionId = request.options.get(kind);
    if (!optionId && kind !== 'reject_once')
      throw new BadRequestException(
        'This Antigravity permission option is unavailable.',
      );
    this.pending.shift();
    request.resolve(permissionOutcome(optionId));
    this.changed();
  }

  answer(
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: AntigravityAnswer,
  ): void {
    const request = this.current;
    if (request?.kind !== 'question' || request.view.requestId !== requestId)
      throw new ConflictException(
        'This Antigravity question is no longer pending.',
      );
    this.pending.shift();
    request.resolve({
      action,
      ...(action === 'accept' ? { content: content ?? {} } : {}),
    });
    this.changed();
  }

  cancel(): void {
    for (const request of this.pending.splice(0))
      request.resolve(
        request.kind === 'permission'
          ? PERMISSION_CANCELLED
          : QUESTION_CANCELLED,
      );
  }
}
