import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { BackendClientService, ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { TaskTerminalComponent } from '../src/app/task-terminal/task-terminal.component';
import { TerminalStreamFixture } from './terminal-stream-fixture';

@Component({
  selector: 'ex-terminal-stream-demo',
  imports: [TaskTerminalComponent],
  providers: [TerminalStreamFixture, { provide: ELEVENEX_BRIDGE, useExisting: TerminalStreamFixture },
    { provide: BackendClientService, useExisting: TerminalStreamFixture }],
  template: '<ex-task-terminal [selection]="selection" [visible]="visible()" />',
  styles: ':host { display: flex; height: 100%; min-height: 0; padding: var(--space-2); } ex-task-terminal { flex: 1; min-width: 0; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalStreamDemoComponent {
  readonly platform = inject(TerminalStreamFixture);
  readonly selection = { scopeId: 'terminal-preview', taskId: 1 };
  readonly visible = signal(true);
}
