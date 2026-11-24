import { and, eq } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import { sessionReplyReturns, sessions } from '../database/schema/index.js';
import { SessionCompletionOutbox } from './session-completion-outbox.js';

/** Owns active waits and durable acknowledgements from session tools. */
export class SessionDelegationHandoffs {
  private readonly logger = new Logger(SessionDelegationHandoffs.name);
  private readonly waits = new Map<number, Map<number, number>>();
  readonly outbox: SessionCompletionOutbox;

  constructor(private readonly db: DrizzleDB, private readonly changed: (sessionId: number) => void) {
    this.outbox = new SessionCompletionOutbox(db);
  }

  waiting(recipientId: number, sessionId: number): boolean {
    return this.waits.get(sessionId)?.has(recipientId) ?? false;
  }

  observe(recipientId: number, targets: readonly number[]): () => void {
    const watched = [...new Set(targets)].filter(target => target !== recipientId);
    for (const id of watched) {
      let callers = this.waits.get(id);
      if (!callers) this.waits.set(id, callers = new Map());
      const count = callers.get(recipientId) ?? 0;
      callers.set(recipientId, count + 1);
      if (!count) this.changed(id);
    }
    return () => {
      for (const id of watched) {
        const callers = this.waits.get(id);
        const count = callers?.get(recipientId);
        if (!callers || !count) continue;
        if (count > 1) callers.set(recipientId, count - 1);
        else {
          callers.delete(recipientId);
          if (!callers.size) this.waits.delete(id);
          this.changed(id);
        }
      }
    };
  }

  returned(sessionId: number, itemId: string, recipientId: number): void {
    if (!itemId || itemId.length > 1000 || sessionId === recipientId) return;
    try {
      const recipient = this.db.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.id, recipientId), eq(sessions.surface, 'session'))).get();
      if (!recipient) return;
      const inserted = this.db.insert(sessionReplyReturns).values({
        sessionId, itemId, recipientId, at: new Date().toISOString(),
      }).onConflictDoNothing().run();
      if (inserted.changes) this.changed(sessionId);
    } catch (error) {
      // A presentation receipt must never prevent the tool from delivering its reply.
      this.logger.warn('Could not record a session reply handoff: ' + String(error));
    }
  }

  collected(sessionId: number, recipientId: number): void {
    try {
      this.outbox.consume(sessionId, recipientId);
    } catch (error) {
      this.logger.warn('Could not record completion notice collection: ' + String(error));
    }
  }
}
