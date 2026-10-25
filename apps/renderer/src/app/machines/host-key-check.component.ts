import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { IconComponent } from '../ui';

@Component({
  selector: 'ex-host-key-check',
  imports: [IconComponent],
  templateUrl: './host-key-check.component.html',
  styleUrl: './host-key-check.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostKeyCheckComponent {
  readonly host = input.required<string>();
  readonly fingerprint = input.required<string>();
  readonly type = input('ED25519');
  readonly changed = input(false);
  readonly disabled = input(false);
  protected readonly confirmation = signal('');
  protected readonly verifiedIdentity = signal('');
  protected readonly identity = computed(() => `${this.host()}\n${this.fingerprint()}`);
  readonly canTrust = computed(() => !this.disabled() && !!this.host().trim() && !!this.fingerprint().trim() && (!this.changed() || (this.confirmation() === this.host() && this.verifiedIdentity() === this.identity())));

  protected verify(value: string): void {
    this.confirmation.set(value);
    this.verifiedIdentity.set(this.identity());
  }
}
