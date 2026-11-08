import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import type { TaskBrowserCommand, TaskBrowserWorkflow } from '@elevenex/shared';
import { ButtonComponent, ModalLayerComponent } from '../ui';

/** Human-only site requests. Draft prompt text stays local until explicit confirmation. */
@Component({
  selector: 'ex-browser-site-requests',
  imports: [ButtonComponent, ModalLayerComponent],
  templateUrl: './browser-site-requests.component.html',
  styleUrl: './browser-site-requests.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserSiteRequestsComponent {
  readonly tabId = input.required<string>();
  readonly requests = input<readonly TaskBrowserWorkflow[]>([]);
  readonly commandRequested = output<TaskBrowserCommand>();
  readonly selected = signal<Extract<TaskBrowserWorkflow, { kind: 'dialog' }> | null>(null);
  readonly open = signal(false);
  readonly draft = signal('');
  private selectedTab = '';
  constructor() {
    effect(() => {
      const selected = this.selected();
      if (selected && (this.tabId() !== this.selectedTab || !this.requests().some(request => request.id === selected.id))) this.open.set(false);
    });
  }
  review(request: Extract<TaskBrowserWorkflow, { kind: 'dialog' }>): void {
    this.selectedTab = this.tabId(); this.selected.set(request); this.draft.set(request.defaultValue); this.open.set(true);
  }
  answer(accept: boolean): void {
    const request = this.selected();
    if (!request || !this.open() || this.selectedTab !== this.tabId() || !this.requests().some(item => item.id === request.id)) return;
    this.commandRequested.emit({ kind: 'dialog-response', tabId: this.selectedTab, requestId: request.id, accept, text: this.draft() });
    this.open.set(false);
  }
  transfer(request: TaskBrowserWorkflow): void {
    if (request.kind === 'dialog') return;
    this.commandRequested.emit({ kind: request.kind === 'upload' ? 'choose-files' : 'save-download', tabId: this.tabId(), requestId: request.id });
  }
  cancel(request: TaskBrowserWorkflow): void { this.commandRequested.emit({ kind: 'cancel-workflow', tabId: this.tabId(), requestId: request.id }); }
  updateDraft(event: Event): void { if (event.target instanceof HTMLInputElement) this.draft.set(event.target.value); }
}
