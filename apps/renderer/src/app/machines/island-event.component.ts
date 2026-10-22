import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent, IconComponent } from '../ui';

@Component({
  selector: 'ex-island-event',
  imports: [ButtonComponent, IconComponent],
  template: '<span class="icon"><ex-icon [name]="icon()" [size]="16" /></span><span class="text"><b>{{ title() }}</b>@if (sub()) { <small>{{ sub() }}</small> }</span>@if (action()) { <button exButton size="sm" variant="secondary" (click)="actionRequested.emit()">{{ action() }}</button> }',
  styles: ':host { display: inline-flex; align-items: center; gap: var(--space-3); padding: var(--space-1); } .icon { display: grid; place-items: center; width: var(--space-8); height: var(--space-8); border-radius: var(--radius-full); color: var(--review); background: var(--review-soft); } .text { display: flex; flex-direction: column; gap: var(--space-1); } b { font-size: var(--text-caption-size); font-weight: 600; } small { color: var(--ink-muted); font-size: var(--text-overline-size); } button { pointer-events: auto; position: relative; z-index: 2; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IslandEventComponent {
  readonly icon = input('peer');
  readonly title = input.required<string>();
  readonly sub = input('');
  readonly action = input('');
  readonly actionRequested = output<void>();
}
