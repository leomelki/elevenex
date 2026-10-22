import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent } from '../ui';
import { PickedHost, SshHost } from './machine.models';

@Component({
  selector: 'ex-host-field',
  imports: [ButtonComponent, FoldComponent, IconComponent],
  templateUrl: './host-field.component.html',
  styleUrl: './host-field.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostFieldComponent {
  readonly query = input('');
  readonly hosts = input<readonly SshHost[]>([]);
  readonly picked = input<PickedHost | null>(null);
  readonly disabled = input(false);
  readonly error = input('');
  readonly queryChange = output<string>();
  readonly selected = output<SshHost>();
  readonly submitted = output<string>();
  readonly cleared = output<void>();
  protected readonly focusedIndex = signal(0);
  protected readonly matches = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.hosts().filter(host => `${host.name} ${host.detail}`.toLocaleLowerCase().includes(query)).slice(0, 8);
  });
  protected onInput(value: string): void {
    this.focusedIndex.set(0);
    this.queryChange.emit(value);
  }
  protected keydown(event: KeyboardEvent): void {
    if (this.disabled() || this.picked() || event.isComposing) return;
    const matches = this.matches();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.focusedIndex.update(index => matches.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0);
    } else if (event.key === 'Enter' && !this.disabled()) {
      event.preventDefault();
      const match = matches[this.focusedIndex()];
      if (match) this.selected.emit(match);
      else if (this.query().trim()) this.submitted.emit(this.query().trim());
    }
  }
}
