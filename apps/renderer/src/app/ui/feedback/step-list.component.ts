import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ProgressLineComponent } from './progress-line.component';
import { StatusGlyphComponent } from '../status/status-glyph.component';

/** One keyed step of a sequence the app runs for the user. */
export interface ProgressStep {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly state: 'todo' | 'active' | 'done' | 'failed';
  /** Determinate progress (0–1) for the active step. */
  readonly progress?: number;
  /** Short trailing value such as a percentage or an elapsed time. */
  readonly meta?: string;
}

/**
 * An ordered checklist of steps: done steps checked, the active one running,
 * a failed one marked where it stopped and upcoming ones muted. It is not a
 * live region: the owner announces step changes, so a ticking `meta` never
 * repeats itself to assistive technology.
 */
@Component({
  selector: 'ex-step-list',
  imports: [ProgressLineComponent, StatusGlyphComponent],
  templateUrl: './step-list.component.html',
  styleUrl: './step-list.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StepListComponent {
  readonly steps = input.required<readonly ProgressStep[]>();
  readonly label = input<string>();
  protected readonly stateLabels: Readonly<Record<ProgressStep['state'], string>> = {
    todo: 'Not started', active: 'In progress', done: 'Done', failed: 'Failed',
  };
}
