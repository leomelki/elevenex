import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronDown } from '@ng-icons/lucide';

export interface OptionSelectItem {
  /** Empty string is reserved for the "no explicit choice" entry. */
  value: string;
  label: string;
  description?: string;
  /** Short chip rendered next to the label, e.g. "Agent default". */
  badge?: string;
  disabled?: boolean;
}

/**
 * Listbox-style picker for options that carry a description — the native
 * `<select>` can only show a bare label, which is not enough to choose between
 * models. Keyboard and screen-reader behaviour follows the ARIA listbox
 * pattern; colours come from the theme tokens so it reads correctly in both
 * light and dark mode.
 */
@Component({
  selector: 'app-option-select',
  imports: [OverlayModule, NgIcon],
  templateUrl: './option-select.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideCheck, lucideChevronDown })],
})
export class OptionSelectComponent {
  readonly options = input<OptionSelectItem[]>([]);
  readonly value = input<string>('');
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Trigger text when nothing matches `value`. */
  readonly placeholder = input('Select');
  readonly ariaLabel = input<string>('');
  /** Shown in place of the list when there is nothing to choose from. */
  readonly emptyText = input('No options available');

  readonly valueChange = output<string>();

  private readonly listEl = viewChild<ElementRef<HTMLElement>>('list');
  private readonly triggerElRef =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly instanceId = `option-select-${Math.random().toString(36).slice(2, 9)}`;

  readonly open = signal(false);
  /** Index of the keyboard-highlighted option, -1 when none. */
  readonly activeIndex = signal(-1);

  readonly selectedOption = computed(() =>
    this.options().find((option) => option.value === this.value()),
  );
  readonly triggerLabel = computed(
    () => this.selectedOption()?.label ?? this.placeholder(),
  );
  readonly hasOptions = computed(() => this.options().length > 0);

  toggle(): void {
    if (this.disabled()) {
      return;
    }
    if (this.open()) {
      this.close();
    } else {
      this.openPanel();
    }
  }

  openPanel(): void {
    if (this.disabled()) {
      return;
    }
    this.open.set(true);
    const selectedIndex = this.options().findIndex(
      (option) => option.value === this.value(),
    );
    this.activeIndex.set(
      selectedIndex >= 0 ? selectedIndex : this.firstEnabledIndex(),
    );
    // The panel renders on the next tick; focus it so arrow keys land here.
    queueMicrotask(() => this.listEl()?.nativeElement.focus());
  }

  close(focusTrigger = true): void {
    if (!this.open()) {
      return;
    }
    this.open.set(false);
    this.activeIndex.set(-1);
    if (focusTrigger) {
      this.triggerEl?.focus();
    }
  }

  select(option: OptionSelectItem): void {
    if (option.disabled) {
      return;
    }
    this.close();
    if (option.value !== this.value()) {
      this.valueChange.emit(option.value);
    }
  }

  onTriggerKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault();
      this.openPanel();
    }
  }

  onListKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1);
        return;
      case 'Home':
        event.preventDefault();
        this.activeIndex.set(this.firstEnabledIndex());
        return;
      case 'End':
        event.preventDefault();
        this.activeIndex.set(this.lastEnabledIndex());
        return;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const option = this.options()[this.activeIndex()];
        if (option) {
          this.select(option);
        }
        return;
      }
      case 'Escape':
      case 'Tab':
        this.close();
        return;
      default:
        return;
    }
  }

  optionId(index: number): string {
    return `${this.instanceId}-option-${index}`;
  }

  private get triggerEl(): HTMLButtonElement | undefined {
    return this.triggerElRef()?.nativeElement;
  }

  private moveActive(delta: number): void {
    const options = this.options();
    if (!options.length) {
      return;
    }

    let next = this.activeIndex();
    for (let step = 0; step < options.length; step += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) {
        this.activeIndex.set(next);
        return;
      }
    }
  }

  private firstEnabledIndex(): number {
    return this.options().findIndex((option) => !option.disabled);
  }

  private lastEnabledIndex(): number {
    const options = this.options();
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) {
        return index;
      }
    }
    return -1;
  }
}
