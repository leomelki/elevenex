import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { StatusGlyphComponent } from '../../ui';
import {
  SUMMARY_LABELS,
  type StatusCounts,
  type SummaryStatus,
} from '../task.models';

@Component({
  selector: 'ex-status-summary',
  imports: [StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-summary.component.html',
  styleUrl: './status-summary.component.css',
})
export class StatusSummaryComponent {
  readonly counts = input<StatusCounts>({});
  readonly active = input<SummaryStatus | null>(null);
  readonly selectStatus = output<SummaryStatus | null>();
  protected readonly order: readonly SummaryStatus[] = [
    'attention',
    'running',
    'review',
    'done',
  ];
  protected readonly labels = SUMMARY_LABELS;
}
