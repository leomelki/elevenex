import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../ui';
import { Machine, MACHINE_ICON } from './machine.models';

@Component({
  selector: 'ex-island-name',
  imports: [IconComponent],
  template: '<span class="dot" [style.background]="color()"></span><ex-icon [name]="icons[machine().kind]" [size]="13" /><span class="name">{{ machine().name }}</span>@if (guests()) { <span class="guests"><ex-icon name="peer" [size]="11" />{{ guests() }}</span> }',
  styles: ':host { display: inline-flex; align-items: center; gap: var(--space-2); } .dot { width: 7px; height: 7px; border-radius: 2px; flex: none; } .name { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .guests { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0 var(--space-1); border-radius: var(--radius-full); color: var(--review); background: var(--review-soft); font-size: var(--text-overline-size); }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IslandNameComponent {
  readonly machine = input.required<Machine>();
  readonly guests = input(0);
  protected readonly icons = MACHINE_ICON;
  protected color(): string { return `var(--project-${this.machine().color ?? 'ocean'})`; }
}
