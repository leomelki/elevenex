import { setImmediate as yieldToRuntime } from 'node:timers/promises';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { sessionAgentPrompt } from '../sessions/session-agent-message.js';
import { isSessionSettled } from '../mcp/tools/session-runtime-state.util.js';
import { submitSessionPrompt } from '../mcp/tools/drive/session-prompt-delivery.js';
import { untilSessionDeadline } from '../mcp/tools/session-deadline.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentRuntimeStatePayload,
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
          event.type !== 'complete'
        )
          return;
        const state: AgentRuntimeStatePayload = event.payload;
        if (
          isSessionSettled(state) ||
          state.runPhase === 'error' ||
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
            if (this.outbox.ready(id).length) this.recipients.add(id);
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
    if (this.delivering.has(recipientId) || this.shutdown.signal.aborted)
      return;
    this.delivering.add(recipientId);
    try {
      const handoffs = this.sessions.delegationHandoffs;
      let after = 0;
      const ready: ReturnType<typeof this.outbox.ready> = [];
      while (ready.length < 16) {
        const page = this.outbox.ready(recipientId, after);
        if (!page.length) break;
        after = page[page.length - 1].sessionId;
        ready.push(
          ...page.filter(
            (row) => !handoffs.waiting(recipientId, row.sessionId),
          ),
        );
      }
      if (!ready.length) return;

      const recipient = await this.sessions.findOne(recipientId);
      if (terminalStatus(recipient.status)) {
        this.outbox.discardForRecipient(recipientId);
        return;
      }
      if (recipient.status !== 'active' || recipient.planMode) return;
      const runtime = this.registry.getProvider(recipient.activeAgentProvider);
      const state = await this.readRuntime(runtime, recipientId);
      if (!isSessionSettled(state) || state?.planMode) return;
      await this.sessions.assertSessionWorkspaceLinked(recipientId);
      if (this.shutdown.signal.aborted) return;
      const candidates = ready
        .filter((row) => !handoffs.waiting(recipientId, row.sessionId))
        .slice(0, 16);
      if (!candidates.length) return;
      const claimed = this.outbox.claim(
        recipientId,
        candidates.map((row) => row.sessionId),
        runtime.info.id,
      );
      if (!claimed.length) return;
      const results = candidates.filter((row) =>
        claimed.includes(row.sessionId),
      );
      const text = [
        'Elevenex background delegation update.',
        ...results.map((row) => `Session #${row.sessionId}: ${row.outcome}.`),
        'Collect completed results with await_session_event using includeReply:true. Inspect failed sessions with session_status or read_session. Use the findings to continue the original assignment and verify them before relying on them.',
      ].join('\n');
      const message = sessionAgentPrompt(
        text,
        { sessionId: results[0].sessionId },
        'message',
      );
      await submitSessionPrompt(runtime, recipientId, message, {
        signal: this.shutdown.signal,
        queue: true,
        recordDelivery: (delivery) =>
          this.outbox.record(
            claimed,
            delivery === 'accepted' ? 'accepted' : 'unconfirmed',
          ),
      });
      if (ready.length > claimed.length) this.recipients.add(recipientId);
    } finally {
      this.delivering.delete(recipientId);
    }
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
