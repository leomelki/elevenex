import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../../ui';
import type { TaskSession } from '../task.models';

/** Inert drag ink rendered in a CDK overlay, outside folding/clipped rows. */
@Component({
  selector: 'ex-session-drag-preview',
  imports: [IconComponent, StatusGlyphComponent],
  templateUrl: './session-drag-preview.component.html',
  styleUrl: './session-drag-preview.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[class.docked]': 'docked()', '[class.stacked]': 'stacked()' },
})
export class SessionDragPreviewComponent {
  readonly session = input.required<TaskSession>();
  readonly docked = input(false);
  readonly stacked = input(false);
}
