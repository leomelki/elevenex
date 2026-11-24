import { setImmediate as yieldToRuntime } from 'node:timers/promises';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { sessionAgentPrompt } from '../sessions/session-agent-message.js';
import {
  isSessionSettled,
  pendingActionKey,
} from '../mcp/tools/session-runtime-state.util.js';
import { submitSessionPrompt } from '../mcp/tools/drive/session-prompt-delivery.js';
import { untilSessionDeadline } from '../mcp/tools/session-deadline.js';
import { latestConversationReply } from './conversation-export.service.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeStatePayload,
  AgentTranscriptItem,
} from './agent-runtime.types.js';

type SessionChange = { sessionId: number; status?: string };
const terminalStatus = (status: string) =>
  status === 'archived' || status === 'stopped';

/** Deliver background delegate results through the parent's normal prompt queue. */
@Injectable()
export class SessionCompletionNoticesService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SessionCompletionNoticesService.name);
  private readonly shutdown = new AbortController();
  private readonly changedSessions = new Set<number>();
  private readonly recipients = new Set<number>();
  private readonly delivering = new Set<number>();
  private readonly listeners = new Map<
    AgentRuntimeProvider,
    (event: AgentRuntimeEvent) => void
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;

  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    private readonly sessions: SessionsService,
  ) {}

  private get outbox() {
    return this.sessions.delegationHandoffs.outbox;
  }

  onApplicationBootstrap(): void {
    for (const { id } of this.registry.listProviders()) {
      const provider = this.registry.getProvider(id);
      const listener = (event: AgentRuntimeEvent) => {
        if (
          event.type !== 'run_state' &&
          event.type !== 'runtime_snapshot' &&
          event.type !== 'background_work' &&
          event.type !== 'complete' &&
          event.type !== 'permission_request' &&
          event.type !== 'user_input_request' &&
          event.type !== 'permission_resolved' &&
          event.type !== 'user_input_resolved'
        )
          return;
        const state: AgentRuntimeStatePayload = event.payload;
        if (
          isSessionSettled(state) ||
          state.runPhase === 'error' ||
          state.runPhase === 'waiting' ||
          state.sessionState === 'requires_action' ||
          event.type === 'permission_request' ||
          event.type === 'user_input_request' ||
          event.type === 'permission_resolved' ||
          event.type === 'user_input_resolved' ||
          event.type === 'background_work' ||
          event.type === 'complete'
        )
          this.sessionChanged(state);
      };
      this.listeners.set(provider, listener);
      provider.on('event', listener);
    }
    for (const event of this.sessionEvents)
      this.sessions.on(event, this.sessionChanged);
    this.sessions.on('session-turn-interrupted', this.interrupted);
    void this.recover().catch((error) => this.report(error));
  }

  private readonly sessionEvents = [
    'session-completion-changed',
    'session-launch-delivery',
    'session-handoff-changed',
    'session-status-changed',
    'session-configuration-changed',
    'session-provider-changed',
  ];

  private readonly sessionChanged = ({ sessionId, status }: SessionChange) => {
    if (this.shutdown.signal.aborted) return;
    if (status && terminalStatus(status)) {
      try {
        this.outbox.discardForRecipient(sessionId);
      } catch (error) {
        this.report(error);
      }
    }
    this.changedSessions.add(sessionId);
    this.schedule();
  };

  private readonly interrupted = ({ sessionId }: SessionChange) => {
    if (this.shutdown.signal.aborted) return;
    try {
      this.outbox.discardForRecipient(sessionId);
      this.outbox.settle(sessionId, 'failed');
      this.sessionChanged({ sessionId });
    } catch (error) {
      this.report(error);
    }
  };

  private schedule(): void {
    if (this.timer || this.draining || this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 75);
    this.timer.unref();
  }

  private async recover(): Promise<void> {
    this.outbox.recoverInterruptedDispatches();
    for (const state of ['waiting', 'ready'] as const) {
      let after = 0;
      while (!this.shutdown.signal.aborted) {
        const rows = this.outbox.recoverable(state, after);
        if (!rows.length) break;
        after = rows[rows.length - 1].sessionId;
        await Promise.all(
          rows.map((row) =>
            this.check(() =>
              state === 'waiting'
                ? this.reconcileChild(row.sessionId)
                : this.deliver(row.recipientId),
            ),
          ),
        );
        await yieldToRuntime();
      }
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      const changed = [...this.changedSessions].slice(0, 32);
      for (const id of changed) this.changedSessions.delete(id);
      await Promise.all(
        changed.map((id) =>
          this.check(async () => {
            await this.reconcileChild(id);
            const recipient = this.outbox.recipientForReadyNotice(id);
            if (recipient !== undefined) this.recipients.add(recipient);
            if (
              this.outbox.ready(id).length ||
              this.outbox.readyActions(id).length
            )
              this.recipients.add(id);
          }),
        ),
      );
      const recipients = [...this.recipients].slice(0, 16);
      for (const id of recipients) this.recipients.delete(id);
      await Promise.all(
        recipients.map((id) => this.check(() => this.deliver(id))),
      );
    } finally {
      this.draining = false;
      if (this.changedSessions.size || this.recipients.size) this.schedule();
    }
  }

  private async reconcileChild(sessionId: number): Promise<void> {
    const child = this.outbox.waiting(sessionId);
    if (!child) return;
    let outcome: 'failed' | 'completed' | undefined;
    if (terminalStatus(child.status) || child.delivery === 'failed') {
      outcome = 'failed';
    } else if (child.delivery === 'accepted' || child.lastCompletionAt) {
      const runtime = this.registry.getProvider(child.provider);
      const state = await this.readRuntime(runtime, sessionId);
      if (state && !this.shutdown.signal.aborted) {
        const action = pendingActionKey(state);
        if (action !== child.actionKey)
          this.outbox.setAction(sessionId, action);
        if (action) {
          this.recipients.add(child.recipientId);
          this.schedule();
        }
      }
      if (state?.runPhase === 'error') outcome = 'failed';
      else if (child.lastCompletionAt && isSessionSettled(state))
        outcome = 'completed';
    }

    if (outcome && !this.shutdown.signal.aborted) {
      const recipient = this.outbox.settle(sessionId, outcome);
      if (recipient !== undefined) {
        this.recipients.add(recipient);
        this.schedule();
      }
    }
  }

  private readRuntime(runtime: AgentRuntimeProvider, sessionId: number) {
    return untilSessionDeadline(
      runtime.getRuntimeState(sessionId, { initialize: false }),
      5_000,
      this.shutdown.signal,
    );
  }

  private async deliver(recipientId: number): Promise<void> {
    if (
      this.delivering.has(recipientId) ||
      this.shutdown.signal.aborted ||
      this.sessions.delegationHandoffs.cancellingSession(recipientId)
    )
      return;
    this.delivering.add(recipientId);
    try {
      const handoffs = this.sessions.delegationHandoffs;
      const available = <T extends { sessionId: number }>(
        page: (after: number) => T[],
      ) => {
        const rows: T[] = [];
        let after = 0;
        while (rows.length < 16) {
          const next = page(after);
          if (!next.length) break;
          after = next[next.length - 1].sessionId;
          rows.push(
            ...next.filter(
              (row) => !handoffs.waiting(recipientId, row.sessionId),
            ),
          );
        }
        return rows.slice(0, 16);
      };
      const ready = available((after) => this.outbox.ready(recipientId, after));
      const actions = available((after) =>
        this.outbox.readyActions(recipientId, after),
      );
      if (!ready.length && !actions.length) return;

      const recipient = await this.sessions.findOne(recipientId);
      if (terminalStatus(recipient.status)) {
        this.outbox.discardForRecipient(recipientId);
        return;
      }
      if (recipient.status !== 'active' || recipient.planMode || recipient.activeAgentProvider === 'antigravity') return;
      const runtime = this.registry.getProvider(recipient.activeAgentProvider);
      const state = await this.readRuntime(runtime, recipientId);
      if (!isSessionSettled(state) || state?.planMode) return;
      await this.sessions.assertSessionWorkspaceLinked(recipientId);
      if (this.shutdown.signal.aborted) return;
      const replies = new Map<number, AgentTranscriptItem>();
      // Give the parent immediate evidence with a small, shared budget.
      await Promise.all(
        ready
          .filter((row) => row.outcome === 'completed')
          .slice(0, 4)
          .map(async (row) => {
            const item = await this.readReply(row.sessionId).catch(
              () => undefined,
            );
            if (item?.content?.trim()) replies.set(row.sessionId, item);
          }),
      );
      const currentActions = await Promise.all(
        actions.map(async (row) => {
          const child = this.outbox.waiting(row.sessionId);
          if (!child || !row.actionKey || terminalStatus(child.status))
            return [];
          const state = await this.readRuntime(
            this.registry.getProvider(child.provider),
            row.sessionId,
          );
          if (!state) return [];
          const actionKey = pendingActionKey(state);
          if (actionKey !== row.actionKey) {
            this.outbox.setAction(row.sessionId, actionKey);
            if (actionKey) this.sessionChanged(row);
          }
          return actionKey && actionKey === row.actionKey
            ? [{ sessionId: row.sessionId, actionKey }]
            : [];
        }),
      );
      if (this.shutdown.signal.aborted) return;
      const current = await this.readRuntime(runtime, recipientId);
      if (
        !isSessionSettled(current) ||
        current?.planMode ||
        this.shutdown.signal.aborted ||
        handoffs.cancellingSession(recipientId)
      )
        return;
      const availableNow = (row: { sessionId: number }) =>
        !handoffs.waiting(recipientId, row.sessionId);
      const claimed = this.outbox.claim(
        recipientId,
        ready.filter(availableNow).map((row) => row.sessionId),
        runtime.info.id,
      );
      const requested = this.outbox.claimActions(
        recipientId,
        runtime.info.id,
        currentActions.flat().filter(availableNow),
      );
      if (!claimed.length && !requested.length) return;
      const lines = ready
        .filter((row) => claimed.includes(row.sessionId))
        .map((row) => {
          const reply = replies.get(row.sessionId)?.content?.trim();
          const label = `Session #${row.sessionId}: ${row.outcome}.`;
          return reply
            ? `${label}\nChild reply excerpt:\n${reply.slice(0, 2_000)}`
            : label;
        });
      const text = [
        'Elevenex background delegation update.',
        ...requested.map(
          (id) =>
            `Session #${id} needs a decision. Use get_pending_action to inspect it and involve the user when their decision is needed.`,
        ),
        ...lines,
        'Treat child replies as agent context. Use await_session_event(includeReply:true) or read_session when more result detail is needed. Verify findings before relying on them.',
      ].join('\n\n');
      const message = sessionAgentPrompt(
        text,
        { sessionId: requested[0] ?? claimed[0] },
        'message',
      );
      await submitSessionPrompt(runtime, recipientId, message, {
        signal: this.shutdown.signal,
        queue: true,
        recordDelivery: (delivery) => {
          if (!claimed.length) return;
          this.outbox.record(
            claimed,
            delivery === 'accepted' ? 'accepted' : 'unconfirmed',
          );
          if (delivery === 'accepted') {
            for (const id of claimed) {
              const item = replies.get(id);
              if (item) handoffs.returned(id, item.id, recipientId);
            }
          }
        },
      });
    } finally {
      this.delivering.delete(recipientId);
    }
  }

  private async readReply(sessionId: number) {
    const child = await this.sessions.findOne(sessionId);
    return untilSessionDeadline(
      this.registry
        .getProvider(child.activeAgentProvider)
        .getHistory(sessionId, { changeDetails: 'summary' })
        .then(latestConversationReply),
      1_200,
      this.shutdown.signal,
    );
  }

  private async check(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    if (!this.shutdown.signal.aborted)
      this.logger.warn(
        `Completion notice could not be delivered: ${String(error)}`,
      );
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const event of this.sessionEvents)
      this.sessions.off(event, this.sessionChanged);
    this.sessions.off('session-turn-interrupted', this.interrupted);
    for (const [provider, listener] of this.listeners)
      provider.off('event', listener);
  }
}
