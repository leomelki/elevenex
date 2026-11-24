import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TitleBarComponent } from '../machines';
import { TaskAppsComponent } from './task-apps.component';

@Component({
  selector: 'ex-app-window', imports: [TitleBarComponent, TaskAppsComponent],
  template: `<ex-title-bar>Apps</ex-title-bar>
    @if (context(); as run) {
      <ex-task-apps [standalone]="true" [scopeId]="scope()" [taskId]="run.taskId" [link]="link()" />
    } @else { <p role="status">{{ message() }}</p> }`,
  styles: ':host { display: flex; flex-direction: column; height: 100dvh; background: var(--surface); } ex-title-bar { flex: none; color: var(--ink-muted); font-size: var(--text-caption-size); } p { margin: auto; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppWindowComponent {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly backend = inject(BackendClientService);
  readonly context = signal<{ taskId: number; runId: string } | null>(null);
  readonly scope = computed(() => this.backend.state().scope?.id ?? null);
  readonly link = computed(() => {
    const context = this.context(), scopeId = this.scope();
    return context && scopeId ? { ...context, scopeId } : null;
  });
  readonly message = signal('Opening app window…');
  constructor() {
    const destroy = inject(DestroyRef);
    const unavailable = () => { if (!destroy.destroyed) this.message.set('This app window is unavailable. Open Apps from the task.'); };
    if (!this.bridge.taskAppWindowContext) { unavailable(); return; }
    void this.bridge.taskAppWindowContext().then(context => {
      if (!context) { unavailable(); return; }
      if (!destroy.destroyed) this.context.set(context);
    }, unavailable);
  }
}
