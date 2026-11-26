import { ConflictException } from '@nestjs/common';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { AgentPromptDisposition } from '../agent-runtime/agent-runtime.types.js';
import type { DrizzleDB } from '../database/database.provider.js';
import {
  sessionCompletionNotices as notices,
  sessionPromptReceipts as receipts,
  sessions,
} from '../database/schema/index.js';

export class SessionPromptReceipts {
  constructor(
    private readonly db: DrizzleDB,
    private readonly changed: (sessionId: number) => void,
  ) {}

  read(key: string, fingerprint: string) {
    const receipt = this.db
      .select()
      .from(receipts)
      .where(eq(receipts.key, key))
      .get();
    if (receipt && receipt.fingerprint !== fingerprint)
      throw new ConflictException({
        code: 'session_request_conflict',
        message:
          'This requestId was already used with different message inputs.',
      });
    return receipt;
  }

  reserve(input: typeof receipts.$inferInsert) {
    const result = this.db.transaction(
      (tx) => {
        const existing = this.read(input.key, input.fingerprint);
        if (existing) return { receipt: existing, created: false };
        const receipt = tx.insert(receipts).values(input).returning().get();
        return { receipt, created: true };
      },
      { behavior: 'immediate' },
    );
    if (result.created) this.changed(input.sessionId);
    return result;
  }

  arm(id: string): void {
    this.db.transaction(
      (tx) => {
        const input = tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, id))
          .get();
        if (!input)
          throw new ConflictException('The send receipt no longer exists.');
        const child = tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .get();
        if (!child || child.delegatedBySessionId !== input.senderId)
          throw new ConflictException(
            'Completion delivery requires your own delegate.',
          );
        const pending = tx
          .select({ total: count() })
          .from(notices)
          .where(
            and(
              eq(notices.sessionId, input.sessionId),
              inArray(notices.state, ['waiting', 'ready', 'dispatching']),
            ),
          )
          .get()!.total;
        if (pending >= 64)
          throw new ConflictException(
            'Collect outstanding delegate results before sending more assignments.',
          );
        if (
          tx
            .select({ id: notices.id })
            .from(notices)
            .where(eq(notices.promptId, id))
            .get()
        )
          return;
        tx.insert(notices)
          .values({
            sessionId: child.id,
            recipientId: input.senderId!,
            messageId: input.id,
            promptId: input.id,
            completionAfter: child.lastCompletionAt,
            state: 'waiting',
          })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  record(
    id: string,
    delivery: 'accepted' | 'failed',
    disposition?: AgentPromptDisposition,
  ): void {
    const row = this.db
      .update(receipts)
      .set({ delivery, ...(disposition ? { disposition } : {}) })
      .where(
        and(
          eq(receipts.id, id),
          inArray(receipts.delivery, ['dispatching', 'unconfirmed']),
        ),
      )
      .returning({ sessionId: receipts.sessionId })
      .get();
    if (row) this.changed(row.sessionId);
  }

  recover(): void {
    // Acceptance may have reached the provider before the process stopped. Never replay it.
    this.db
      .update(receipts)
      .set({ delivery: 'unconfirmed' })
      .where(eq(receipts.delivery, 'dispatching'))
      .run();
  }
}
