import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from '@angular/core';

import type { ClassValue } from 'clsx';

import { mergeClasses } from '@/shared/utils/merge-classes';

import {
  progressBarIndicatorVariants,
  progressBarVariants,
  type ZardProgressBarIndicatorVariants,
  type ZardProgressBarVariants,
} from './progress-bar.variants';

/**
 * Determinate progress bar. Indeterminate work should use `z-skeleton` or a
 * spinner instead — a bar that fills without meaning anything is worse than no
 * bar at all.
 */
@Component({
  selector: 'z-progress-bar',
  template: `
    <div
      data-slot="progress-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="percent()"
      [attr.aria-label]="zLabel() || null"
      [class]="classes()"
    >
      <div [class]="indicatorClasses()" [style.width.%]="percent()"></div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    class: 'block',
  },
  exportAs: 'zProgressBar',
})
export class ZardProgressBarComponent {
  /** 0–1. Values outside the range are clamped rather than overflowing the track. */
  readonly zValue = input<number>(0);
  readonly zSize = input<ZardProgressBarVariants['zSize']>('default');
  readonly zType = input<ZardProgressBarIndicatorVariants['zType']>('default');
  readonly zLabel = input<string>('');
  readonly class = input<ClassValue>('');

  protected readonly percent = computed(() =>
    Math.round(Math.min(1, Math.max(0, this.zValue() || 0)) * 100),
  );

  protected readonly classes = computed(() =>
    mergeClasses(progressBarVariants({ zSize: this.zSize() }), this.class()),
  );

  protected readonly indicatorClasses = computed(() =>
    progressBarIndicatorVariants({ zType: this.zType() }),
  );
}
