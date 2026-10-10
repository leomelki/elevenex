import type { Session } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeClient } from './opencode-client.js';

/** Resolves descendant ownership without accepting requests from unrelated sessions. */
export class OpenCodeSessionTree {
  private readonly sessions = new Map<string, Session>();
  private readonly lookups = new Map<string, Promise<Session | undefined>>();

  owns(rootID: string | null, id: string): boolean {
    if (!rootID) return false;
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      if (current === rootID) return true;
      visited.add(current);
      current = this.sessions.get(current)?.parentID;
    }
    return false;
  }
  track(session: Session): void {
    this.sessions.set(session.id, session);
  }
  descendants(rootID: string): Session[] {
    return [...this.sessions.values()].filter(
      (session) => session.id !== rootID && this.owns(rootID, session.id),
    );
  }
  async resolve(
    rootID: string | null,
    id: string,
    client: OpenCodeClient,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!rootID) return false;
    const visited = new Set<string>();
    const ancestors: Session[] = [];
    let current: string | undefined = id;
    while (current && !signal.aborted && !visited.has(current)) {
      if (this.owns(rootID, current)) {
        for (const session of ancestors.reverse()) this.track(session);
        return true;
      }
      visited.add(current);
      let session: Session | undefined = this.sessions.get(current);
      if (!session) {
        let lookup = this.lookups.get(current);
        if (!lookup) {
          const sessionID: string = current;
          lookup = client.session
            .get({ sessionID }, { signal })
            .then((result) => result.data)
            .catch(() => undefined)
            .finally(() => {
              this.lookups.delete(sessionID);
            });
          this.lookups.set(sessionID, lookup);
        }
        session = await lookup;
      }
      if (!session || session.id !== current || signal.aborted) return false;
      // Keep verified descendants only; global event streams can contain thousands of unrelated sessions.
      ancestors.push(session);
      current = session.parentID;
    }
    return false;
  }
  async restore(
    rootID: string,
    client: OpenCodeClient,
    signal: AbortSignal,
  ): Promise<void> {
    const before = new Map(this.sessions);
    const visited = new Set([rootID]);
    const pending = [rootID];
    let cursor = 0;
    while (cursor < pending.length && !signal.aborted) {
      const batch = pending.slice(cursor, cursor + 4);
      cursor += batch.length;
      const results = await Promise.all(
        batch.map((sessionID) =>
          client.session.children({ sessionID }, { signal }),
        ),
      );
      for (let index = 0; index < results.length; index++)
        for (const child of results[index].data ?? []) {
          if (visited.has(child.id) || signal.aborted) continue;
          // Some legacy responses omit parentID; the scoped children endpoint establishes it.
          if (this.sessions.get(child.id) === before.get(child.id))
            this.track({ ...child, parentID: batch[index] });
          visited.add(child.id);
          pending.push(child.id);
        }
    }
    const previousDescendants = new Set(
      [...before.keys()].filter((id) => this.owns(rootID, id)),
    );
    if (!signal.aborted)
      for (const [id, session] of before)
        if (
          !visited.has(id) &&
          previousDescendants.has(id) &&
          this.sessions.get(id) === session
        )
          this.sessions.delete(id);
  }
}
