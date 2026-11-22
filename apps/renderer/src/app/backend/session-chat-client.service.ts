import { Injectable, inject } from "@angular/core";
import type {
  BackendResult,
  SessionChatAgentRead,
  SessionChatAgentPage,
  ChatAttachmentUpload,
  ChatAttachmentReceipt,
  SessionChatCatalog,
  SessionChatCatalogRead,
  SessionChatCommand,
  SessionChatCommandReply,
  SessionChatPage,
  SessionChatRead,
  SessionChatTurnWorkReply,
  SessionChatTurnWorkRead,
  SessionChatToolDetailsReply,
  SessionChatToolDetailsRead,
  SessionChatChangesRead,
  SessionChatChangesPage,
  SessionChatContentRead,
  SessionChatContent,
  SessionChatMediaRead,
  SessionChatMedia,
  SessionChatStreamEvent,
  SessionChatWatch,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "./backend-client.service";

@Injectable({ providedIn: "root" })
export class SessionChatClient {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly backend = inject(BackendClientService);
  agent(scope: string, input: SessionChatAgentRead): Promise<BackendResult<SessionChatAgentPage>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatAgent(scope, input));
  }
  upload(scope: string, input: ChatAttachmentUpload): Promise<BackendResult<ChatAttachmentReceipt>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatUpload(scope, input));
  }
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
  watch(scope: string, input: SessionChatWatch, receive: (event: SessionChatStreamEvent) => boolean) {
    let active = true;
    let delivery = 0;
    const unsubscribe = this.bridge.onSessionChatStream(event => {
      if (!active || this.backend.state().scope?.id !== scope ||
          event.scopeId !== scope || event.watchId !== input.watchId ||
          event.taskId !== input.taskId || event.sessionId !== input.sessionId) return;
      if (event.type === 'page' && event.delivery !== delivery + 1) return;
      if (receive(event) && active && event.type === 'page') {
        delivery = event.delivery;
        void this.bridge.sessionChatAcknowledge(scope, input.watchId, event.delivery).catch(() => undefined);
      }
    });
    const started = this.invoke(scope, false, () => this.bridge.sessionChatWatch(scope, input));
    return {
      started,
      close: () => {
        if (!active) return;
        active = false;
        unsubscribe();
        void this.bridge.sessionChatUnwatch(scope, input.watchId).catch(() => undefined);
      },
    };
  }
  turnWork(scope: string, input: SessionChatTurnWorkRead): Promise<BackendResult<SessionChatTurnWorkReply>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatTurnWork(scope, input));
  }
  toolDetails(scope: string, input: SessionChatToolDetailsRead): Promise<BackendResult<SessionChatToolDetailsReply>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatToolDetails(scope, input));
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
  media(scope: string, input: SessionChatMediaRead): Promise<BackendResult<SessionChatMedia>> {
    return this.invoke(scope, false, () => this.bridge.sessionChatMedia(scope, input));
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
