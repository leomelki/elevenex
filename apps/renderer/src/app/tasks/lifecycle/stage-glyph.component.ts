import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TASK_STAGE_LABELS, type TaskStage } from '../task.models';
@Component({
  selector: 'ex-stage-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 14 14"
    role="img"
    [attr.aria-label]="labels[stage()]"
  >
    @if (stage() === 'closed') {
      <rect x="1" y="1" width="12" height="12" rx="3.5" fill="currentColor" />
      <path
        d="M4.4 7.2l1.7 1.7 3.5-3.8"
        fill="none"
        stroke="var(--surface-raised)"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    } @else {
      <rect
        x="1.75"
        y="1.75"
        width="10.5"
        height="10.5"
        rx="3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        [attr.stroke-dasharray]="stage() === 'planned' ? '2.4 2' : null"
      />
      @if (stage() === 'active') {
        <rect x="4" y="7" width="6" height="3" rx="1" fill="currentColor" />
      }
      @if (stage() === 'waiting') {
        <path
          d="M5.75 5v4M8.25 5v4"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      }
    }
  </svg>`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      color: var(--ink-muted);
    }
    svg {
      display: block;
    }
  `,
})
export class StageGlyphComponent {
  readonly stage = input<TaskStage>('planned');
  readonly size = input(14);
  protected readonly labels = TASK_STAGE_LABELS;
}
