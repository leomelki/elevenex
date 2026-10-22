import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../../ui';
import type { TaskSession } from '../task.models';
@Component({
  selector: 'ex-session-row',
  imports: [IconComponent, StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './session-row.component.html',
  styleUrl: './session-row.component.css',
})
export class SessionRowComponent {
  readonly session = input.required<TaskSession>();
  readonly selected = input(false);
  readonly depth = input(0);
  readonly activated = output<string>();
  protected readonly kindIcon = computed(() =>
    this.session().kind === 'fork'
      ? 'fork'
      : this.session().kind === 'side'
        ? 'side-chat'
        : null,
  );
}
