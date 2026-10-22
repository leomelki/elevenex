import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonComponent, IconComponent } from '../ui';

@Component({
  selector: 'ex-host-key-check',
  imports: [ButtonComponent, IconComponent],
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
  readonly trusted = output<{ host: string; fingerprint: string; replaced: boolean }>();
  readonly cancelled = output<void>();
  protected readonly confirmation = signal('');
  protected readonly verifiedIdentity = signal('');
  protected readonly identity = computed(() => `${this.host()}\n${this.fingerprint()}`);
  protected readonly canTrust = computed(() => !this.disabled() && !!this.host().trim() && !!this.fingerprint().trim() && (!this.changed() || (this.confirmation() === this.host() && this.verifiedIdentity() === this.identity())));

  protected verify(value: string): void {
    this.confirmation.set(value);
    this.verifiedIdentity.set(this.identity());
  }
  protected trust(): void {
    if (this.canTrust()) this.trusted.emit({ host: this.host(), fingerprint: this.fingerprint(), replaced: this.changed() });
  }
}
