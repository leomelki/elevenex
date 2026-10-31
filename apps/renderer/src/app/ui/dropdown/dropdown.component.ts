import { CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, afterRenderEffect, computed, input, output, viewChild } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { DropdownMenuComponent } from './dropdown-menu.component';
import { DropdownRadioComponent } from './dropdown-item.component';

export interface DropdownOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly mark?: string;
  readonly disabled?: boolean;
}

/** Controlled, single-choice dropdown. Options are a bounded, owner-supplied list. */
@Component({
  selector: 'ex-dropdown',
  imports: [CdkMenuTrigger, IconComponent, DropdownMenuComponent, DropdownRadioComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dropdown.component.html',
  styleUrl: './dropdown.component.css',
})
export class DropdownComponent {
  readonly options = input.required<readonly DropdownOption[]>();
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly prefix = input('');
  readonly placeholder = input('Choose…');
  readonly mono = input(false);
  readonly icon = input<string>();
  readonly disabled = input(false);
  /** Compact sunken selector from the agent settings design. */
  readonly appearance = input<'default' | 'subtle' | 'quiet'>('default');
  /** Close portaled content immediately when a retained owner becomes inactive. */
  readonly active = input(true);
  readonly changed = output<string>();
  protected readonly selected = computed(() => this.options().find(option => option.id === this.value()));
  protected readonly unavailable = computed(() => this.disabled() || !this.active() || !this.options().some(option => !option.disabled));
  private readonly trigger = viewChild(CdkMenuTrigger);

  constructor() {
    afterRenderEffect(() => {
      if (this.unavailable()) this.trigger()?.close();
    });
  }
}
