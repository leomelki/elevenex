import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import type { RemoteChallenge } from '@elevenex/shared';
import { ButtonComponent, IconComponent } from '../../ui';
import { HostKeyCheckComponent } from '../index';

/** Transient sign-in UI. Secrets never enter settings, logs or a reusable store. */
@Component({
  selector: 'ex-remote-challenge-dialog',
  imports: [ButtonComponent, IconComponent, HostKeyCheckComponent],
  templateUrl: './remote-challenge-dialog.component.html',
  styleUrl: './remote-challenge-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'dialog', 'aria-labelledby': 'remote-challenge-title' },
})
export class RemoteChallengeDialogComponent {
  readonly challenge = input.required<RemoteChallenge>();
  readonly machineName = input.required<string>();
  readonly active = input(true);
  readonly busy = input(false);
  readonly error = input('');
  readonly answered = output<{ readonly id: string; readonly answer: string | null }>();
  protected readonly secret = signal('');
  protected readonly expired = signal(false);
  protected readonly fingerprint = computed(() => /(?:SHA256:[A-Za-z0-9+/]+|MD5:(?:[a-f0-9]{2}:){15}[a-f0-9]{2})/i.exec(this.challenge().prompt)?.[0] ?? '');
  protected readonly keyType = computed(() => /\b(ED25519|ECDSA|RSA|DSA)\b/i.exec(this.challenge().prompt)?.[1]?.toUpperCase() ?? 'SSH');
  protected readonly canAnswer = computed(() => this.active() && !this.busy() && !this.expired() && (this.challenge().kind === 'credential' ? !!this.secret() : this.challenge().kind !== 'trust' || !!this.fingerprint()));

  constructor() {
    effect(onCleanup => {
      const challenge = this.challenge();
      this.secret.set(''); this.expired.set(challenge.expiresAt <= Date.now());
      const timer = setTimeout(() => { this.expired.set(true); this.secret.set(''); }, Math.max(0, challenge.expiresAt - Date.now()));
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => { if (!this.active()) this.secret.set(''); });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.canAnswer()) return;
    const answer = this.challenge().kind === 'credential' ? this.secret() : 'yes';
    this.secret.set(''); this.answered.emit({ id: this.challenge().id, answer });
  }
  cancel(): void { if (this.active() && !this.busy()) { this.secret.set(''); this.answered.emit({ id: this.challenge().id, answer: null }); } }
}
