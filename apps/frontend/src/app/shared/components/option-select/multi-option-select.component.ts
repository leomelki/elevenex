import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  input,
  numberAttribute,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronDown } from '@ng-icons/lucide';
import type { OptionSelectItem } from './option-select.component';

/**
 * The multi-select sibling of `OptionSelectComponent`, sharing its look and its
 * ARIA behaviour. Selection order is preserved and surfaced, because the
 * callers that need several values also treat the first one as the primary —
 * a set rendered alphabetically would hide that.
 *
 * The panel stays open while options are toggled: picking three languages
 * should not mean reopening the list three times.
 */
@Component({
  selector: 'app-multi-option-select',
  imports: [OverlayModule, NgIcon],
  templateUrl: './multi-option-select.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideCheck, lucideChevronDown })],
})
export class MultiOptionSelectComponent {
  readonly options = input<OptionSelectItem[]>([]);
  readonly values = input<string[]>([]);
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Trigger text when nothing is selected. */
  readonly placeholder = input('Select');
  readonly ariaLabel = input<string>('');
  readonly emptyText = input('No options available');
  /** 0 leaves the selection uncapped. */
  readonly max = input(0, { transform: numberAttribute });
  /**
   * Chip shown against the first selection. Empty hides it, for callers whose
   * order carries no meaning.
   */
  readonly primaryBadge = input('');

  readonly valuesChange = output<string[]>();

  private readonly listEl = viewChild<ElementRef<HTMLElement>>('list');
  private readonly triggerElRef =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly instanceId = `multi-option-select-${Math.random().toString(36).slice(2, 9)}`;

  readonly open = signal(false);
  /** Index of the keyboard-highlighted option, -1 when none. */
  readonly activeIndex = signal(-1);

  private readonly selected = computed(() => new Set(this.values()));

  readonly triggerLabel = computed(() => {
    const labels = this.values()
      .map(
        (value) =>
          this.options().find((option) => option.value === value)?.label ??
          value,
      )
      .filter(Boolean);
    return labels.length ? labels.join(', ') : this.placeholder();
  });

  readonly hasSelection = computed(() => this.values().length > 0);

  /** True once no further option may be added, so the rest read as disabled. */
  readonly atLimit = computed(() => {
    const max = this.max();
    return max > 0 && this.values().length >= max;
  });

  isSelected(value: string): boolean {
    return this.selected().has(value);
  }

  isPrimary(value: string): boolean {
    return !!this.primaryBadge() && this.values()[0] === value;
  }

  isBlocked(option: OptionSelectItem): boolean {
    return (
      !!option.disabled || (this.atLimit() && !this.isSelected(option.value))
    );
  }

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
    const firstSelected = this.options().findIndex((option) =>
      this.isSelected(option.value),
    );
    this.activeIndex.set(
      firstSelected >= 0 ? firstSelected : this.firstEnabledIndex(),
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

  /** Adds to the end or removes, leaving the panel open either way. */
  select(option: OptionSelectItem): void {
    if (this.isBlocked(option)) {
      return;
    }
    const values = this.values();
    this.valuesChange.emit(
      this.isSelected(option.value)
        ? values.filter((value) => value !== option.value)
        : [...values, option.value],
    );
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

  /**
   * Skips over what cannot be picked. Options blocked only by the cap stay
   * reachable, so a keyboard user can still land on them to read why.
   */
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
