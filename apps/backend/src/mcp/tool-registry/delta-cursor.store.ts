import { Injectable } from '@nestjs/common';

/**
 * Per-connection cursors so `read_session` (and other delta reads) return only
 * what changed since the caller last looked — the core of the token economy.
 *
 * Keyed by `<mcpSessionId>:<scope>` where scope is usually the target session
 * id. Stateless external clients can ignore this and pass an explicit cursor
 * back instead; the in-app agent relies on it for "no new items" cheapness.
 */
@Injectable()
export class DeltaCursorStore {
  private readonly cursors = new Map<string, string>();

  private key(mcpSessionId: string | undefined, scope: string | number): string {
    return `${mcpSessionId ?? 'anon'}:${scope}`;
  }

  /** Last cursor this connection saw for the scope, or undefined if never. */
  get(mcpSessionId: string | undefined, scope: string | number): string | undefined {
    return this.cursors.get(this.key(mcpSessionId, scope));
  }

  /** Record the latest cursor after a successful read. */
  set(
    mcpSessionId: string | undefined,
    scope: string | number,
    cursor: string,
  ): void {
    this.cursors.set(this.key(mcpSessionId, scope), cursor);
  }

  /** Drop all cursors for a closed connection. */
  clearConnection(mcpSessionId: string): void {
    const prefix = `${mcpSessionId}:`;
    for (const key of this.cursors.keys()) {
      if (key.startsWith(prefix)) this.cursors.delete(key);
    }
  }
}
