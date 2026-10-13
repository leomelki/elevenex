import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { fromEvent, Subscription } from 'rxjs';
import { toast } from 'ngx-sonner';
import type { SessionFolder } from '../models/session.model';
import {
  getBackendOrigin,
  getBackendServerId,
  isBackendOriginReady,
} from '../runtime/runtime-config';
import { ClaudeStatusService } from './claude-status.service';

type ArchiveKind = 'session' | 'folder';
interface ArchiveDecision {
  kind: ArchiveKind;
  id: number;
  owner: DestroyRef;
  origin: string;
  serverId: string;
  archive: () => void;
}

@Injectable({ providedIn: 'root' })
export class SessionArchiveUiService {
  private readonly document = inject(DOCUMENT);
  private readonly status = inject(ClaudeStatusService);
  private readonly pending = signal<ArchiveDecision | null>(null);
  private readonly ready = signal(false);
  readonly confirmReady = this.ready.asReadonly();
  private enableTimer?: ReturnType<typeof setTimeout>;
  private dismissTimer?: ReturnType<typeof setTimeout>;
  private listeners?: Subscription;
  private unregisterOwner?: () => void;

  isPending(kind: ArchiveKind, id: number, owner?: DestroyRef): boolean {
    const decision = this.pending();
    return decision?.kind === kind && decision.id === id && (!owner || decision.owner === owner);
  }

  pendingSessionId(owner: DestroyRef): number | null {
    const decision = this.pending();
    return decision?.owner === owner && decision.kind === 'session' ? decision.id : null;
  }

  request(sessionId: number, archive: () => void, owner: DestroyRef): void {
    this.requestDecision('session', sessionId, [sessionId], archive, owner);
  }

  requestFolder(
    folder: Pick<SessionFolder, 'id' | 'sessions'>,
    archive: () => void,
    owner: DestroyRef,
  ): void {
    this.requestDecision(
      'folder',
      folder.id,
      folder.sessions.map((session) => session.id),
      archive,
      owner,
    );
  }

  confirm(owner: DestroyRef): void {
    const decision = this.pending();
    if (!decision || decision.owner !== owner || !this.ready()) return;
    this.cancel(owner);
    if (owner.destroyed) return;
    if (
      !isBackendOriginReady() ||
      decision.origin !== getBackendOrigin() ||
      decision.serverId !== getBackendServerId()
    ) {
      toast.info('The backend changed. Request archiving again on the selected backend.');
      return;
    }
    decision.archive();
  }

  cancel(owner?: DestroyRef): void {
    if (owner && this.pending()?.owner !== owner) return;
    clearTimeout(this.enableTimer);
    clearTimeout(this.dismissTimer);
    this.enableTimer = this.dismissTimer = undefined;
    this.listeners?.unsubscribe();
    this.listeners = undefined;
    this.unregisterOwner?.();
    this.unregisterOwner = undefined;
    this.pending.set(null);
    this.ready.set(false);
  }

  private requestDecision(
    kind: ArchiveKind,
    id: number,
    sessionIds: readonly number[],
    archive: () => void,
    owner: DestroyRef,
  ): void {
    if (owner.destroyed || this.isPending(kind, id, owner)) return;
    if (!isBackendOriginReady()) {
      toast.error('Connect to the selected backend before archiving.');
      return;
    }
    this.cancel();
    const needsConfirmation = sessionIds.some((sessionId) => {
      const activity = this.status.getKnownActivity(sessionId);
      return !activity || activity.activityStatus === 'running' || activity.backgroundActive;
    });
    if (!needsConfirmation) {
      archive();
      return;
    }
    this.pending.set({
      kind,
      id,
      owner,
      origin: getBackendOrigin(),
      serverId: getBackendServerId(),
      archive,
    });
    this.unregisterOwner = owner.onDestroy(() => this.cancel(owner));
    // Match delete: guard double clicks, then dismiss after inactivity.
    this.enableTimer = setTimeout(() => this.ready.set(true), 300);
    this.dismissTimer = setTimeout(() => this.cancel(owner), 3000);
    this.listeners = new Subscription();
    this.listeners.add(
      fromEvent<KeyboardEvent>(this.document, 'keydown').subscribe((event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        this.cancel(owner);
      }),
    );
    this.listeners.add(
      fromEvent<PointerEvent>(this.document, 'pointerdown').subscribe((event) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.closest('[data-session-archive-controls]')
        )
          this.cancel(owner);
      }),
    );
  }
}
