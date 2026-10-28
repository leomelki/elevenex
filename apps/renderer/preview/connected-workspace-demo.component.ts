import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { BackendClientService, ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { MachineWorkspaceComponent } from '../src/app/machines/application/machine-workspace.component';
import { IslandNameComponent, TitleBarComponent, TitleIslandComponent, type Machine } from '../src/app/machines';
import { ButtonComponent } from '../src/app/ui';
import { ConnectedWorkspaceFixture } from './connected-workspace-fixture';

@Component({
  selector: 'ex-connected-workspace-demo',
  imports: [MachineWorkspaceComponent, TitleBarComponent, TitleIslandComponent, IslandNameComponent, ButtonComponent],
  providers: [ConnectedWorkspaceFixture, BackendClientService, { provide: ELEVENEX_BRIDGE, useExisting: ConnectedWorkspaceFixture }],
  template: `<div class="controls"><span>Production connected workspace · controlled backend</span><button exButton size="sm" (click)="fixture.busyTask()">A busy task</button><button exButton size="sm" (click)="fixture.empty()">No projects</button><button exButton size="sm" (click)="fixture.failure()">Read failure</button><button exButton size="sm" (click)="fixture.recoverWorkspace()">Recover</button></div><div class="window" data-modal-window><div class="window-content" data-modal-background><ex-title-bar><ex-title-island label="Machine details"><ex-island-name [machine]="machine" /></ex-title-island></ex-title-bar>@if (workspaceVisible()) { <ex-machine-workspace [machine]="machine" [active]="true" /> }</div></div>`,
  styles: `:host { display: flex; flex-direction: column; height: 100%; min-height: 0; } .controls { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); } .controls span { margin-right: auto; color: var(--ink-muted); font-size: var(--text-caption-size); } .window, .window-content { flex: 1; display: flex; flex-direction: column; min-height: 0; } ex-machine-workspace { flex: 1; min-height: 0; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectedWorkspaceDemoComponent {
  /** Recreate the production owner while retaining the isolated platform's saved context. */
  readonly workspaceVisible = signal(true);
  readonly fixture = inject(ConnectedWorkspaceFixture);
  readonly machine: Machine = { id: 'local', name: 'This Mac', kind: 'local', conn: 'live', color: 'pine' };
}
