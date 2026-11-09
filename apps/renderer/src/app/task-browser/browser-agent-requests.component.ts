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
  imports: [ButtonComponent, IconComponent],
  templateUrl: './browser-agent-requests.component.html',
  styleUrl: './browser-agent-requests.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserAgentRequestsComponent {
  readonly requests = input<readonly BrowserHumanRequest[]>([]);
  readonly busy = input(false);
  readonly picking = input(false);
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
