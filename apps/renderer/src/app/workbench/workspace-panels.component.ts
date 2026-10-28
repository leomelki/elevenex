import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { PanelTabsComponent, type PanelTab } from '../tasks';
import { IconButtonComponent, IconComponent } from '../ui';

/** Side-view navigation only. Platform-backed panel contents are a separate slice. */
@Component({
  selector: 'ex-workspace-panels',
  imports: [PanelTabsComponent, IconButtonComponent, IconComponent],
  templateUrl: './workspace-panels.component.html',
  styleUrl: './workspace-panels.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePanelsComponent {
  readonly panel = model('changes');
  readonly wide = input(false);
  readonly closed = output<void>();
  readonly wideChange = output<boolean>();
  readonly tabs: readonly PanelTab[] = [
    { id: 'terminal', label: 'Terminal', icon: 'terminal', panelId: 'workspace-panel-terminal' },
    { id: 'actions', label: 'Actions', icon: 'actions', panelId: 'workspace-panel-actions' },
    { id: 'changes', label: 'Changes', icon: 'changes', panelId: 'workspace-panel-changes' },
    { id: 'code', label: 'Code', icon: 'code', panelId: 'workspace-panel-code' },
    { id: 'browser', label: 'Browser', icon: 'globe', panelId: 'workspace-panel-browser' },
  ];
  protected readonly current = computed(() => this.tabs.find(tab => tab.id === this.panel()) ?? this.tabs[2]!);
}
