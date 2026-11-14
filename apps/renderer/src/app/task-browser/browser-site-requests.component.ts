import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import type { TaskBrowserCommand, TaskBrowserWorkflow } from '@elevenex/shared';
import { ButtonComponent, IconComponent, ModalLayerComponent } from '../ui';

type SiteDialogRequest = Extract<TaskBrowserWorkflow, { kind: 'dialog' }>;
type SiteDialogType = SiteDialogRequest['type'];

/** Who is asking, as far as the renderer can tell: the host names the title, the origin sits under it. */
export interface SiteIdentity {
  /** Punycode hostname (the URL parser's form), so lookalike letters can't borrow another site's name. */
  readonly host: string | null;
  /** Scheme, host and port; null for pages without a network origin (about:, data:). */
  readonly origin: string | null;
}

/** Reads the identity from the tab's URL. Dialogs from cross-origin frames still show the tab's site. */
export function siteIdentity(url: string): SiteIdentity {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: null, origin: null };
    return { host: parsed.hostname, origin: parsed.origin };
  } catch { return { host: null, origin: null }; }
}

const dialogIcons: Record<SiteDialogType, string> = { alert: 'chat', confirm: 'question', prompt: 'pencil', beforeunload: 'back' };

/** Human-only site requests. Draft prompt text stays local until explicit confirmation. */
@Component({
  selector: 'ex-browser-site-requests',
  imports: [ButtonComponent, IconComponent, ModalLayerComponent],
  templateUrl: './browser-site-requests.component.html',
  styleUrl: './browser-site-requests.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserSiteRequestsComponent {
  readonly tabId = input.required<string>();
  /** The tab's current URL; names the site in the request bar and the dialog. */
  readonly pageUrl = input('');
  readonly requests = input<readonly TaskBrowserWorkflow[]>([]);
  readonly commandRequested = output<TaskBrowserCommand>();
  readonly selected = signal<SiteDialogRequest | null>(null);
  readonly open = signal(false);
  readonly draft = signal('');
  protected readonly site = computed(() => siteIdentity(this.pageUrl()));
  /** Captured on review so a retained dialog keeps its title through its exit. */
  protected readonly selectedSite = signal<SiteIdentity>({ host: null, origin: null });
  private selectedTab = '';
  constructor() {
    effect(() => {
      const selected = this.selected();
      if (selected && (this.tabId() !== this.selectedTab || !this.requests().some(request => request.id === selected.id))) this.open.set(false);
    });
  }
  review(request: SiteDialogRequest): void {
    this.selectedTab = this.tabId(); this.selectedSite.set(this.site()); this.selected.set(request); this.draft.set(request.defaultValue); this.open.set(true);
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

  protected requestIcon(request: TaskBrowserWorkflow): string {
    return request.kind === 'dialog' ? dialogIcons[request.type] : request.kind === 'upload' ? 'attach' : 'download';
  }
  protected requestText(request: SiteDialogRequest): string {
    switch (request.type) {
      case 'alert': return 'has a message for you';
      case 'confirm': return 'asks you to confirm';
      case 'prompt': return 'asks you for text';
      case 'beforeunload': return 'asks before you leave';
    }
  }
  protected dialogIcon(type: SiteDialogType): string { return dialogIcons[type]; }
  protected dialogTitle(type: SiteDialogType, site: SiteIdentity): string {
    if (type === 'beforeunload') return 'Leave this site?';
    return `${site.host ?? 'This page'} says`;
  }
}
