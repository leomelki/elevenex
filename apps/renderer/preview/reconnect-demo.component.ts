import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BackendClientService, ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { MachineAppComponent } from '../src/app/machines/application/machine-app.component';
import { ButtonComponent } from '../src/app/ui';
import { ConnectedWorkspaceFixture } from './connected-workspace-fixture';

/** Production window and feature stores with an isolated, controlled transport. */
@Component({
  selector: 'ex-reconnect-demo',
  imports: [MachineAppComponent, ButtonComponent],
  providers: [ConnectedWorkspaceFixture, BackendClientService, { provide: ELEVENEX_BRIDGE, useExisting: ConnectedWorkspaceFixture }],
  template: `<div class="controls"><span>Controlled transport · production desktop UI</span><button exButton size="sm" (click)="platform.recover()">Disconnect</button><button exButton size="sm" (click)="platform.challenge('credential')">Unlock key</button><button exButton size="sm" (click)="platform.fail(true)">Host identity</button><button exButton size="sm" (click)="platform.ready()">Reconnect</button></div><ex-machine-app />`,
  styles: `:host { display: flex; flex-direction: column; height: 100%; min-height: 0; } .controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); } span { margin-right: auto; color: var(--ink-muted); font-size: var(--text-caption-size); } ex-machine-app { flex: 1; min-height: 0; height: auto; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReconnectDemoComponent { readonly platform = inject(ConnectedWorkspaceFixture); }
