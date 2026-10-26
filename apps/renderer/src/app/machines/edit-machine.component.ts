import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { ButtonComponent, DropdownComponent, IconComponent, KbdComponent, SetValueComponent } from '../ui';
import { MACHINE_ICON, Machine, MachineColor, MachineEditPatch } from './machine.models';

interface MachineDraft extends Machine { readonly hue: MachineColor; readonly portText: string }

/** One initial draft per machine identity. The owner persists and reconnects. */
@Component({
  selector: 'ex-edit-machine',
  imports: [ButtonComponent, DropdownComponent, IconComponent, KbdComponent, SetValueComponent],
  templateUrl: './edit-machine.component.html',
  styleUrls: ['./add-machine.component.css', './edit-machine.component.css'],
  host: { role: 'dialog', '[attr.aria-label]': "(removing() ? removeLabel() + ' ' : 'Edit ') + machine().name", '[attr.inert]': "disabled() ? '' : null" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditMachineComponent {
  readonly machine = input.required<Machine>();
  readonly step = input<'edit' | 'remove'>('edit');
  readonly disabled = input(false);
  readonly saving = input(false);
  readonly error = input('');
  readonly saved = output<MachineEditPatch>();
  readonly removeRequested = output<void>();
  readonly cancelled = output<void>();
  /** A native picker grants access in main; this dialog never accepts file paths. */
  readonly identityRequested = output<void>();
  readonly identityLabel = input('');
  protected readonly hues: readonly MachineColor[] = ['ocean', 'pine', 'plum', 'rust', 'steel', 'rose'];
  protected readonly icons = MACHINE_ICON;
  protected readonly draft = linkedSignal<Machine, MachineDraft>({
    source: this.machine,
    computation: (machine, previous) => previous?.source.id === machine.id ? previous.value : { ...machine, hue: machine.hue ?? machine.color ?? 'steel', portText: machine.port?.toString() ?? '' },
  });
  protected readonly removing = linkedSignal(() => this.step() === 'remove');
  protected readonly removeLabel = computed(() => this.machine().kind === 'peer' ? 'Unpair' : 'Remove');
  protected readonly moved = computed(() => this.machine().kind === 'ssh' && (this.draft().host !== this.machine().host || this.draft().user !== this.machine().user || this.draft().portText !== (this.machine().port?.toString() ?? '')));
  protected readonly valid = computed(() => {
    const draft = this.draft(), port = draft.portText;
    return !!draft.name.trim() && draft.name.length <= 160 && (draft.kind !== 'ssh' || !!draft.host?.trim() && (!port || /^\d{1,5}$/.test(port) && +port > 0 && +port <= 65535));
  });
  protected readonly signIn = computed(() => [...(this.machine().key ? [{ id: 'unchanged', label: this.machine().key! }] : []), { id: 'default', label: 'SSH agent / SSH config' }, { id: 'identity', label: this.identityLabel() || 'Choose an SSH key…' }]);
  protected readonly signInChoice = linkedSignal(() => this.identityLabel() ? 'identity' : this.machine().key ? 'unchanged' : 'default');

  protected patch(patch: Partial<ReturnType<typeof this.draft>>): void { if (!this.disabled() && !this.saving()) this.draft.update(draft => ({ ...draft, ...patch })); }
  protected signInChanged(id: string): void { if (id === 'identity') this.identityRequested.emit(); else if (id === 'default' || id === 'unchanged') this.signInChoice.set(id); }
  protected remove(): void {
    if (this.disabled() || this.saving() || this.machine().kind === 'local') return;
    if (this.machine().windows) this.removing.set(true); else this.removeRequested.emit();
  }
  protected save(event: Event): void {
    event.preventDefault();
    if (this.disabled() || this.saving() || !this.valid()) return;
    const draft = this.draft();
    this.saved.emit({ name: draft.name.trim(), hue: draft.hue, ...(draft.kind === 'ssh' ? { host: draft.host?.trim(), user: draft.user?.trim(), port: draft.portText ? +draft.portText : undefined, key: this.signInChoice() === 'unchanged' ? undefined : this.signInChoice() } : {}) });
  }
}
