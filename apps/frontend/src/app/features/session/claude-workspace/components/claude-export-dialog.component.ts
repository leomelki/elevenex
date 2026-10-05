import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideClipboardCopy, lucideLoaderCircle } from '@ng-icons/lucide';

export type ExportPrecision = 'full' | 'medium' | 'small';

export interface ExportRequest {
  precision: ExportPrecision;
  includeChanges: boolean;
  includeIds: boolean;
}

interface PrecisionOption {
  value: ExportPrecision;
  label: string;
  hint: string;
}

/**
 * Presentational dialog for choosing conversation-export options. Owns the option
 * state and emits the chosen options on copy; the parent performs the request,
 * clipboard write and toast.
 */
@Component({
  selector: 'cw-export-dialog',
  standalone: true,
  imports: [NgIcon, TrackNativeModalDirective],
  viewProviders: [provideIcons({ lucideClipboardCopy, lucideLoaderCircle })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-export-dialog.component.html',
})
export class ClaudeExportDialogComponent {
  readonly open = input(false);
  readonly busy = input(false);

  readonly close = output<void>();
  readonly copy = output<ExportRequest>();

  readonly precision = signal<ExportPrecision>('medium');
  readonly includeChanges = signal(true);
  readonly includeIds = signal(true);

  readonly precisionOptions: PrecisionOption[] = [
    { value: 'small', label: 'Small', hint: 'Only your messages and each final response.' },
    {
      value: 'medium',
      label: 'Medium',
      hint: 'Adds assistant text and tool calls (inputs only, no results).',
    },
    {
      value: 'full',
      label: 'Full',
      hint: 'Everything: thinking, tool inputs and outputs, and change hunks.',
    },
  ];

  activeHint(): string {
    return this.precisionOptions.find((option) => option.value === this.precision())?.hint ?? '';
  }

  emitCopy(): void {
    this.copy.emit({
      precision: this.precision(),
      includeChanges: this.includeChanges(),
      includeIds: this.includeIds(),
    });
  }
}
