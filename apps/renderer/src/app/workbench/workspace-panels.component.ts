import { NgTemplateOutlet } from '@angular/common';
import { TemplateRef, ChangeDetectionStrategy, Component, ElementRef, Injector, OnChanges, SimpleChanges, afterNextRender, computed, contentChild, inject, input, model, output } from '@angular/core';
import { PanelTabsComponent, type PanelTab } from '../tasks';
import { OpensWhenBackComponent } from '../machines';
import { IconButtonComponent, IconComponent } from '../ui';

/** Side-view navigation only. Platform-backed panel contents are a separate slice. */
@Component({
  selector: 'ex-workspace-panels',
  imports: [NgTemplateOutlet, PanelTabsComponent, IconButtonComponent, IconComponent, OpensWhenBackComponent],
  templateUrl: './workspace-panels.component.html',
  styleUrl: './workspace-panels.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePanelsComponent implements OnChanges {
  readonly codeActions = input<TemplateRef<unknown> | null>(null);
  readonly codeContent = contentChild('workspaceCode');
  readonly changesContent = contentChild('workspaceChanges');
  readonly terminalContent = contentChild('workspaceTerminal');
  readonly browserContent = contentChild('workspaceBrowser');
  readonly appsContent = contentChild('workspaceApps');
  readonly appsVisible = input(false);
  readonly panel = model('changes');
  readonly unreachable = input<string>();
  readonly reconnectRequested = output<void>();
  readonly wide = input(false);
  readonly closed = output<void>();
  readonly wideChange = output<boolean>();
  protected readonly panels: readonly PanelTab[] = [
    { id: 'terminal', label: 'Terminal', icon: 'terminal', panelId: 'workspace-panel-terminal' },
    { id: 'actions', label: 'Actions', icon: 'actions', panelId: 'workspace-panel-actions' },
    { id: 'changes', label: 'Changes', icon: 'changes', panelId: 'workspace-panel-changes' },
    { id: 'code', label: 'Code', icon: 'code', panelId: 'workspace-panel-code' },
    { id: 'browser', label: 'Browser', icon: 'globe', panelId: 'workspace-panel-browser' },
    { id: 'apps', label: 'Apps', icon: 'window', panelId: 'workspace-panel-apps' },
  ];
  protected readonly tabs = computed(() => this.appsVisible() ? this.panels : this.panels.filter(tab => tab.id !== 'apps'));
  protected readonly current = computed(() => this.tabs().find(tab => tab.id === this.panel()) ?? this.panels[2]!);
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['appsVisible']?.previousValue || this.appsVisible()) return;
    const document = this.root.ownerDocument;
    const appsFocus = this.root.querySelectorAll('[aria-controls="workspace-panel-apps"], #workspace-panel-apps');
    if (![...appsFocus].some(element => element.contains(document.activeElement))) return;
    afterNextRender({ write: () => {
      if (this.appsVisible()) return;
      if (document.activeElement === document.body || [...appsFocus].some(element => element.contains(document.activeElement))) {
        this.root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
      }
    } }, { injector: this.injector });
  }
}
