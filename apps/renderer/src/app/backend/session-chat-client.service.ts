import { Injectable, inject } from "@angular/core";
import type {
  BackendResult,
  SessionChatCatalog,
  SessionChatCatalogRead,
  SessionChatCommand,
  SessionChatCommandReply,
  SessionChatPage,
  SessionChatRead,
  SessionChatChangesRead,
  SessionChatChangesPage,
  SessionChatContentRead,
  SessionChatContent,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "./backend-client.service";

@Injectable({ providedIn: "root" })
export class SessionChatClient {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly backend = inject(BackendClientService);
  changes(scope: string, input: SessionChatChangesRead): Promise<BackendResult<SessionChatChangesPage>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatChanges(scope, input));
  }
  read(
    scope: string,
    input: SessionChatRead,
  ): Promise<BackendResult<SessionChatPage>> {
    return this.invoke(scope, false, () =>
      this.bridge.sessionChatRead(scope, input),
    );
  }
  catalog(scope: string, input: SessionChatCatalogRead): Promise<BackendResult<SessionChatCatalog>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatCatalog(scope, input));
  }
  command(
    scope: string,
    input: SessionChatCommand,
  ): Promise<BackendResult<SessionChatCommandReply>> {
    return this.invoke(scope, true, () =>
      this.bridge.sessionChatCommand(scope, input),
    );
  }
  content(
    scope: string,
    input: SessionChatContentRead,
  ): Promise<BackendResult<SessionChatContent>> {
    return this.invoke(scope, false, () =>
      this.bridge.sessionChatContent(scope, input),
    );
  }
  cancel(scope: string, requestId: string): void {
    void this.bridge
      .sessionChatCancel?.(scope, requestId)
      .catch(() => undefined);
  }
  private async invoke<T>(
    scope: string,
    mutation: boolean,
    call: () => Promise<BackendResult<T>>,
  ): Promise<BackendResult<T>> {
    const stale = (): BackendResult<T> => ({
      ok: false,
      error: {
        code: "stale-scope",
        message: "The machine changed. Reopen this session.",
      },
    });
    if (this.backend.state().scope?.id !== scope) return stale();
    let result: BackendResult<T>;
    try {
      result = await call();
    } catch {
      result = {
        ok: false,
        error: {
          code: mutation ? "outcome-unknown" : "transport",
          message: mutation
            ? "The action may have completed. Check the conversation before trying again."
            : "Could not connect to this conversation.",
        },
      };
    }
    return this.backend.state().scope?.id === scope ? result : stale();
  }
}
