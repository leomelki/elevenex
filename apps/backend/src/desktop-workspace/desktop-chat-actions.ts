import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AgentRuntimeProviderFeatures } from '../agent-runtime/agent-runtime.types.js';
import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import { record } from './desktop-chat-projection.js';

/** Validate durable requests and delegate to the selected harness without replay. */
export async function executeChatAction(
  sessions: SessionsService,
  registry: AgentRuntimeRegistryService,
  sessionId: number,
  session: Awaited<ReturnType<SessionsService['findOne']>>,
  action: Record<string, unknown>,
) {
  const provider = registry.getProvider(session.activeAgentProvider);
  if (action.type === 'stop') {
    await provider.interrupt(sessionId);
    return { accepted: true };
  }
  await sessions.assertSessionWorkspaceLinked(sessionId);
  if (session.status === 'archived')
    throw new BadRequestException('Archived sessions are read-only.');
  const text = (value: unknown, max = 1000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new BadRequestException('Invalid conversation action.');
    return value;
  };
  const feature = <K extends keyof AgentRuntimeProviderFeatures>(key: K) =>
    registry.getProviderFeature(session.activeAgentProvider, key);
  switch (action.type) {
    case 'provider': {
      const next = text(action.provider);
      registry.getProvider(next);
      if (session.activeAgentProvider !== text(action.expectedProvider))
        throw new ConflictException(
          'The selected harness changed. Refresh this conversation.',
        );
      if (next === session.activeAgentProvider) break;
      if (sessions.hasStartedAgentRuntime(session))
        throw new BadRequestException(
          'Choose a harness in a new session. This conversation has already started.',
        );
      const runtime = record(
        await provider.getRuntimeState(sessionId, { initialize: false }),
      );
      if (
        runtime.canInterrupt ||
        runtime.runPhase === 'running' ||
        runtime.runPhase === 'waiting' ||
        runtime.pendingPermissionRequest ||
        runtime.pendingUserInputRequest ||
        (Array.isArray(runtime.pendingPrompts) && runtime.pendingPrompts.length)
      )
        throw new ConflictException(
          'Wait for the current operation to finish before choosing a harness.',
        );
      await sessions.updateActiveAgentProvider(sessionId, next);
      break;
    }
    case 'send':
      if (typeof action.queue !== 'boolean')
        throw new BadRequestException('Invalid queue option.');
      if (session.status === 'stopped')
        await sessions.reactivateRuntime(sessionId);
      await provider.submitPrompt(
        sessionId,
        text(action.text, 64000),
        undefined,
        undefined,
        { human: true, queue: action.queue },
      );
      break;
    case 'cancel-queued':
      await provider.cancelPendingPrompt(sessionId, text(action.id));
      break;
    case 'steer-queued':
      await provider.steerPendingPrompt(sessionId, text(action.id));
      break;
    case 'resume-queue':
      await provider.resumePendingPrompts(sessionId);
      break;
    case 'permission': {
      const raw = record(await provider.getRuntimeState(sessionId)),
        request = record(raw.pendingPermissionRequest);
      if (request.requestId !== action.id)
        throw new BadRequestException('This permission is no longer pending.');
      if (action.decision === 'denied')
        await feature('denyPermission').denyPermission(
          sessionId,
          text(action.id),
        );
      else if (
        action.decision === 'approved' ||
        (action.decision === 'always' &&
          request.suppressAlwaysAllowRule !== true)
      )
        await feature('approvePermission').approvePermission(
          sessionId,
          text(action.id),
          action.decision === 'always',
        );
      else throw new BadRequestException('Unsupported permission decision.');
      break;
    }
    case 'answer': {
      const raw = record(await provider.getRuntimeState(sessionId)),
        permission = record(raw.pendingPermissionRequest);
      const permissionQuestion =
        permission.toolKind === 'ask_user_question' ||
        String(permission.toolName).toLowerCase() === 'askuserquestion';
      const request = permissionQuestion
        ? permission
        : record(raw.pendingUserInputRequest);
      if (request.requestId !== action.id)
        throw new BadRequestException('This question is no longer pending.');
      const answers = record(action.answers),
        content: Record<string, string | number | boolean | string[]> = {};
      if (Object.keys(answers).length > 20)
        throw new BadRequestException('Too many answers.');
      for (const [key, value] of Object.entries(answers)) {
        if (!Array.isArray(value) || value.length > 30)
          throw new BadRequestException('Invalid answer.');
        const values = value.map((item) => text(item, 4000));
        const field = record(
          record(record(request.requestedSchema).properties)[key],
        );
        content[text(key)] =
          field.type === 'boolean'
            ? values[0] === 'true'
            : field.type === 'number' || field.type === 'integer'
              ? Number(values[0])
              : field.type === 'array' || (!field.type && values.length > 1)
                ? values
                : values.join(', ');
        if (typeof content[key] === 'number' && !Number.isFinite(content[key]))
          throw new BadRequestException('Invalid numeric answer.');
      }
      // Harness question protocols use question IDs (or full question text) as keys.
      if (permissionQuestion) {
        if (action.decline === true)
          await feature('denyPermission').denyPermission(
            sessionId,
            text(action.id),
          );
        else
          await feature('approvePermission').approvePermission(
            sessionId,
            text(action.id),
            false,
            { answers: content },
          );
      } else
        await feature('answerUserInput').answerUserInput(
          sessionId,
          text(action.id),
          action.decline === true ? 'decline' : 'accept',
          content,
        );
      break;
    }
    case 'model':
      await provider.setSelectedModel(
        sessionId,
        action.model === null ? null : text(action.model),
      );
      break;
    case 'plan':
      if (typeof action.enabled !== 'boolean')
        throw new BadRequestException('Invalid plan option.');
      await feature('setPlanMode').setPlanMode(sessionId, action.enabled);
      break;
    case 'permission-mode': {
      const mode = text(action.mode);
      if (!provider.info.permissionModes?.includes(mode))
        throw new BadRequestException('Unsupported permission mode.');
      await feature('setPermissionMode').setPermissionMode(sessionId, mode);
      break;
    }
    default:
      throw new BadRequestException('Unsupported conversation action.');
  }
  return { accepted: true };
}
