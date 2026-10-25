import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, input, output, signal, viewChild } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

@Component({ selector: 'ex-set-group', changeDetection: ChangeDetectionStrategy.OnPush, template: `
  @if (title()) { <div class="title">{{ title() }}</div> }
  <div class="card"><ng-content /></div>
  @if (note()) { <div class="note">{{ note() }}</div> }
`, styles: `
  :host { display: flex; flex-direction: column; gap: 6px; }
  .title { font-size: 12px; font-weight: 600; color: var(--ink-muted); padding: 0 2px; }
  .card { border-radius: var(--radius-md); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
  .note { font-size: 12px; color: var(--ink-muted); padding: 0 2px; }
` })
export class SetGroupComponent {
  readonly title = input<string>();
  readonly note = input<string>();
}

@Component({ selector: 'ex-set-row', changeDetection: ChangeDetectionStrategy.OnPush, template: `
  <span class="label"><span>{{ label() }}</span>@if (sub()) { <span class="sub">{{ sub() }}</span> }</span>
  <span class="control"><ng-content /></span>
`, styles: `
  :host { box-sizing: content-box; display: flex; align-items: center; gap: 16px; min-height: 48px; padding: 8px 14px; }
  :host:not(:first-child) { border-top: 1px solid var(--line); }
  .label { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 13px; }
  .sub { font-size: 12px; color: var(--ink-muted); }
  .control { flex: none; display: flex; align-items: center; gap: 8px; max-width: 100%; }
  @media (max-width: 480px) { :host { align-items: flex-start; flex-direction: column; gap: 6px; } }
` })
export class SetRowComponent {
  readonly label = input.required<string>();
  readonly sub = input<string>();
}

@Component({ selector: 'ex-set-field', changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.mono]': 'mono()', '[class.wide]': 'wide()' },
  template: `<input #field [value]="value()" [placeholder]="placeholder()" [attr.aria-label]="label()" [disabled]="disabled()" spellcheck="false" (input)="valueChanged.emit(field.value)" />`,
  styles: `
    :host { display: inline-flex; max-width: 100%; }
    input { width: 160px; max-width: 100%; height: 30px; box-sizing: border-box; padding: 0 10px; border: 0; border-radius: 8px; background: var(--surface-raised); box-shadow: inset 0 0 0 1px var(--line); font: inherit; font-size: 13px; color: var(--ink); outline: 0; transition: box-shadow var(--dur-fast) var(--ease-out); }
    input:focus { box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 3px var(--accent-soft); }
    :host(.mono) input { font-family: var(--font-mono); font-size: 12px; }
    :host(.wide) input { width: 260px; }
    input:disabled { opacity: .45; }
  ` })
export class SetFieldComponent {
  readonly value = input('');
  readonly placeholder = input('');
  readonly label = input.required<string>();
  readonly mono = input(false);
  readonly wide = input(false);
  readonly disabled = input(false);
  readonly valueChanged = output<string>();
}

export { SetChoiceComponent, type SettingChoice } from './set-choice.component';

@Component({
  selector: 'ex-set-value', imports: [IconComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './set-value.component.html', styleUrl: './set-value.component.css',
  host: { '[class.well]': 'well()', '[class.field]': 'field()' },
})
export class SetValueComponent {
  readonly value = input('');
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly mono = input(false);
  readonly well = input(false);
  readonly prompt = input(false);
  readonly field = input(false);
  readonly disabled = input(false);
  readonly changed = output<string>();
  readonly inputChanged = output<string>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly inputElement = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly button = viewChild<ElementRef<HTMLButtonElement>>('button');
  private refocus = false;
  private original = '';

  constructor() {
    afterRenderEffect(() => {
      if (this.editing()) {
        const input = this.inputElement()?.nativeElement;
        input?.focus(); input?.select();
      } else if (this.refocus) {
        this.refocus = false;
        this.button()?.nativeElement.focus({ preventScroll: true });
      }
    });
  }

  protected begin(): void { this.original = this.value(); this.draft.set(this.original); this.editing.set(true); }
  protected type(value: string): void { this.draft.set(value); this.inputChanged.emit(value); }
  protected finish(keep: boolean): void {
    if (!this.editing()) return;
    this.editing.set(false);
    if (keep && this.draft() !== this.original) this.changed.emit(this.draft());
    else if (!keep) this.inputChanged.emit(this.original);
  }
  protected key(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); this.refocus = true; this.finish(event.key === 'Enter');
  }
}
