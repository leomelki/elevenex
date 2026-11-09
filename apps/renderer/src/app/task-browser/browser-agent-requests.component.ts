import { ElementPreviewComponent, type ConversationAttachment } from '../conversation';
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { BrowserHumanRequest, TaskBrowserCommand } from '@elevenex/shared';
import { ButtonComponent, IconComponent } from '../ui';

/** Presentational requests. The host owns tickets, selection and handoff. */
@Component({
  selector: 'ex-browser-agent-requests',
  imports: [ElementPreviewComponent, ButtonComponent, IconComponent],
  templateUrl: './browser-agent-requests.component.html',
  styleUrl: './browser-agent-requests.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserAgentRequestsComponent {
  readonly requests = input<readonly BrowserHumanRequest[]>([]);
  readonly busy = input(false);
  readonly picking = input(false);
  readonly elementShared = output<BrowserHumanRequest>();
  snapshot(request: BrowserHumanRequest): ConversationAttachment | null {
    const snapshot = request.selection?.snapshot;
    return snapshot?.jpeg ? { id: snapshot.reference.id, name: snapshot.reference.label, path: '', kind: 'image', status: 'ready', preview: 'data:image/jpeg;base64,' + snapshot.jpeg, element: snapshot.reference } : null;
  }
  readonly commandRequested = output<TaskBrowserCommand>();
  command(
    kind:
      | 'agent-request-complete'
      | 'agent-request-cancel'
      | 'agent-request-pick',
    requestId: string,
  ): void {
    if (!this.busy()) this.commandRequested.emit({ kind, requestId });
  }
  show(tabId: string): void {
    if (!this.busy()) this.commandRequested.emit({ kind: 'select', tabId });
  }
}
