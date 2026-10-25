import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ButtonComponent, EaseSwapComponent, IconComponent } from '../ui';

@Component({
  selector: 'ex-host-key-check',
  imports: [ButtonComponent, EaseSwapComponent, IconComponent],
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
  protected readonly verifiedIdentity = signal('');
  protected readonly identity = computed(() => `${this.host()}\n${this.fingerprint()}`);
  protected readonly hasIdentity = computed(() => !!this.host().trim() && !!this.fingerprint().trim());
  readonly confirmed = computed(() => this.hasIdentity() && this.verifiedIdentity() === this.identity());
  readonly canTrust = computed(() => !this.disabled() && this.hasIdentity() && (!this.changed() || this.confirmed()));

  protected confirm(): void {
    if (this.disabled() || !this.hasIdentity()) return;
    this.verifiedIdentity.set(this.identity());
  }
}
