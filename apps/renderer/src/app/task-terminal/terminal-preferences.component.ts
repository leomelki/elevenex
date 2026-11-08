import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, linkedSignal, output, viewChild } from '@angular/core';
import type { TaskTerminalPreferences } from '@elevenex/shared';
import { ButtonComponent, SetFieldComponent, SetGroupComponent, SetRowComponent, SheetComponent, SwitchComponent } from '../ui';

@Component({
  selector: 'ex-terminal-preferences',
  imports: [ButtonComponent, SheetComponent, SetFieldComponent, SetGroupComponent, SetRowComponent, SwitchComponent],
  templateUrl: './terminal-preferences.component.html', styleUrl: './terminal-preferences.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalPreferencesComponent {
  readonly open = input(false);
  readonly initial = input.required<TaskTerminalPreferences>();
  readonly busy = input(false);
  readonly error = input('');
  readonly closed = output<void>();
  readonly saved = output<TaskTerminalPreferences>();
  readonly id = `terminal-settings-${crypto.randomUUID()}`;
  // Keep the closing surface intact; reopening starts a fresh controlled draft.
  private readonly draft = computed(() => ({ open: this.open(), value: this.initial() }));
  readonly custom = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): boolean => open ? value.profile !== null : previous?.value ?? false });
  readonly executable = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): string => open ? value.profile?.executable ?? '' : previous?.value ?? '' });
  readonly args = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): string => open ? value.profile?.args.join('\n') ?? '' : previous?.value ?? '' });
  readonly env = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): string => open
    ? Object.entries(value.profile?.env ?? {}).map(([key, entry]) => entry === null ? key : `${key}=${entry}`).join('\n') : previous?.value ?? '' });
  readonly login = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): boolean => open ? value.profile?.login ?? false : previous?.value ?? false });
  readonly prediction = linkedSignal({ source: this.draft, computation: ({ open, value }, previous): boolean => open ? value.prediction === 'auto' : previous?.value ?? true });
  readonly invalid = linkedSignal({ source: this.draft, computation: ({ open }, previous): string => open ? '' : previous?.value ?? '' });
  private readonly footer = viewChild<ElementRef<HTMLElement>>('footer');

  constructor() {
    afterRenderEffect(() => {
      // Validation can add several lines above the focused Save button. Keep
      // the feedback and action visible within the sheet's own scroll region.
      if (this.open() && (this.invalid() || this.error())) this.footer()?.nativeElement.scrollIntoView({ block: 'nearest' });
    });
  }

  save(): void {
    this.invalid.set('');
    const entries: [string, string | null][] = [];
    for (const line of (this.custom() ? this.env().split('\n').filter(line => line.length) : [])) {
      const at = line.indexOf('='), key = at < 0 ? line : line.slice(0, at);
      if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(key) || key.startsWith('ELEVENEX_') || entries.some(([name]) => name === key)) {
        this.invalid.set('Use one unique NAME=value per line. A name alone removes an inherited variable. ELEVENEX_ variables are reserved.'); return;
      }
      entries.push([key, at < 0 ? null : line.slice(at + 1)]);
    }
    const args = this.args() ? this.args().split('\n') : [];
    if (this.custom() && (!this.executable().trim() || this.executable().includes('\0') || args.length > 32 || args.some(value => value.length > 4096) || entries.length > 64)) {
      this.invalid.set('Enter a shell executable, at most 32 arguments and at most 64 environment variables.'); return;
    }
    this.saved.emit({ prediction: this.prediction() ? 'auto' : 'off', profile: this.custom() ? {
      executable: this.executable().trim(), args, env: Object.fromEntries(entries), login: this.login(),
    } : null });
  }
}
