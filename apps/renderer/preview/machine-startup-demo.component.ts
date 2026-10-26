import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BackendClientService, ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { MachineAppComponent } from '../src/app/machines/application/machine-app.component';
import { ButtonComponent } from '../src/app/ui';
import { MachineStartupFixture } from './machine-startup-fixture';

@Component({
  selector: 'ex-machine-startup-demo',
  imports: [MachineAppComponent, ButtonComponent],
  providers: [MachineStartupFixture, BackendClientService, { provide: ELEVENEX_BRIDGE, useExisting: MachineStartupFixture }],
  template: `<div class="controls" aria-label="Platform fixture controls"><span>Production machine flow · controlled platform</span><button exButton size="sm" (click)="platform.ready()">Ready</button><button exButton size="sm" (click)="platform.challenge()">Trust</button><button exButton size="sm" (click)="platform.challenge('credential')">Sign in</button><button exButton size="sm" (click)="platform.fail()">Fail</button><button exButton size="sm" (click)="platform.fail(true)">Key changed</button><button exButton size="sm" (click)="platform.recover()">Lose connection</button></div><ex-machine-app style="height: calc(100dvh - 120px)" />`,
  styles: `.controls { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2); flex-wrap: wrap; } span { margin-right: auto; font-size: var(--text-caption-size); color: var(--ink-muted); }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineStartupDemoComponent { readonly platform = inject(MachineStartupFixture); }
