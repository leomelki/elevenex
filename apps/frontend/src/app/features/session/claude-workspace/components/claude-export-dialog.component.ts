import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideClipboardCopy, lucideLoaderCircle } from '@ng-icons/lucide';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

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
  template: `
    <dialog
      trackNativeModal
      [trackNativeModalOpen]="open()"
      [open]="open()"
      class="fixed inset-0 m-auto max-w-md rounded-lg border border-border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40"
      (close)="close.emit()"
    >
      <h2 class="mb-1 text-lg font-semibold">Export conversation</h2>
      <p class="mb-4 text-sm text-muted-foreground">
        Copies a Markdown transcript, optimized for pasting into another assistant.
      </p>

      <div class="mb-4">
        <label class="mb-1.5 block text-sm font-medium">Detail</label>
        <div class="grid grid-cols-3 gap-1 rounded-md border border-border bg-muted/40 p-1">
          @for (option of precisionOptions; track option.value) {
            <button
              type="button"
              (click)="precision.set(option.value)"
              [attr.aria-pressed]="precision() === option.value"
              class="rounded px-2 py-1.5 text-xs font-medium transition-colors"
              [class]="
                precision() === option.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              "
            >
              {{ option.label }}
            </button>
          }
        </div>
        <p class="mt-1.5 text-xs text-muted-foreground">{{ activeHint() }}</p>
      </div>

      <label class="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          [checked]="includeChanges()"
          (change)="includeChanges.set($any($event.target).checked)"
          class="size-4 accent-primary"
        />
        Include changes per response
      </label>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          [checked]="includeIds()"
          (change)="includeIds.set($any($event.target).checked)"
          class="size-4 accent-primary"
        />
        Include message IDs
        <span class="text-xs text-muted-foreground">— grep details back from a full export</span>
      </label>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          (click)="close.emit()"
          class="rounded px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          [disabled]="busy()"
          (click)="emitCopy()"
          class="inline-flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ng-icon
            [name]="busy() ? 'lucideLoaderCircle' : 'lucideClipboardCopy'"
            [class.animate-spin]="busy()"
            size="14"
          />
          {{ busy() ? 'Copying…' : 'Copy' }}
        </button>
      </div>
    </dialog>
  `,
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
