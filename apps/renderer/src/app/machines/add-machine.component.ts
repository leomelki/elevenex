import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, viewChild } from '@angular/core';
import { AutoHeightDirective, ButtonComponent, EaseSwapComponent, IconComponent, KbdComponent } from '../ui';
import { HostFieldComponent } from './host-field.component';
import { HostKeyCheckComponent } from './host-key-check.component';
import { PairPasteComponent } from './pair-paste.component';
import { AddMachineIntent, AddMachineKind, PairedComputer, PickedHost, SshHost } from './machine.models';

/** Asks for connection details. Its owner resolves hosts/peers, checks keys and starts preparation. */
@Component({
  selector: 'ex-add-machine',
  imports: [AutoHeightDirective, ButtonComponent, EaseSwapComponent, IconComponent, KbdComponent, HostFieldComponent, HostKeyCheckComponent, PairPasteComponent],
  templateUrl: './add-machine.component.html',
  styleUrl: './add-machine.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'dialog', '[attr.aria-label]': 'title()', '(keydown)': 'keydown($event)' },
})
export class AddMachineComponent {
  readonly kind = input.required<AddMachineKind>();
  readonly step = input<'host' | 'key'>('host');
  readonly query = input('');
  readonly hosts = input<readonly SshHost[]>([]);
  readonly picked = input<PickedHost | null>(null);
  readonly fingerprint = input('');
  readonly keyType = input('ED25519');
  readonly keyChanged = input(false);
  readonly text = input('');
  readonly found = input<PairedComputer | null>(null);
  readonly loading = input(false);
  readonly disabled = input(false);
  readonly error = input('');
  readonly notice = input('');
  readonly queryChange = output<string>();
  readonly hostSelected = output<SshHost>();
  readonly hostSubmitted = output<string>();
  readonly textChange = output<string>();
  readonly keyRequested = output<PickedHost>();
  readonly confirmed = output<AddMachineIntent>();
  readonly backRequested = output<void>();
  readonly cancelled = output<void>();
  private readonly keyCheck = viewChild(HostKeyCheckComponent);
  private readonly primary = viewChild<unknown, ElementRef<HTMLButtonElement>>('primary', { read: ElementRef });
  private previousBody?: string;
  private focusKey = false;
  protected readonly title = computed(() => this.kind() === 'ssh' ? 'Add a server' : 'Pair another computer');
  protected readonly label = computed(() => this.kind() === 'peer' ? 'Pair' : this.step() === 'key' ? 'Trust and connect' : 'Connect');
  protected readonly canProceed = computed(() => !this.disabled() && !this.loading() && !this.error() && (
    this.kind() === 'peer' ? !!this.text().trim() && !!this.found()
      : !!this.picked() && (this.step() === 'host' || !!this.keyCheck()?.canTrust())
  ));

  constructor() {
    afterRenderEffect(() => {
      const body = this.kind() === 'peer' ? 'paste' : this.step();
      const changed = this.previousBody !== undefined && this.previousBody !== body;
      this.previousBody = body;
      if (changed) this.focusKey = body === 'key';
      // A view query can settle one render after the body changes. Keep the
      // request until the new primary action is rendered and enabled.
      if (this.focusKey && this.keyCheck() && this.canProceed()) {
        const primary = this.primary()?.nativeElement;
        if (primary && !primary.disabled) { primary.focus({ preventScroll: true }); this.focusKey = false; }
      }
    });
  }

  protected next(): void {
    if (!this.canProceed()) return;
    if (this.kind() === 'peer') {
      const computer = this.found();
      if (computer) this.confirmed.emit({ kind: 'peer', computer, text: this.text() });
    } else {
      const host = this.picked();
      if (!host) return;
      if (this.step() === 'host') this.keyRequested.emit(host);
      else this.confirmed.emit({ kind: 'ssh', host, fingerprint: this.fingerprint(), keyType: this.keyType(), replaced: this.keyChanged() });
    }
  }

  protected back(): void {
    if (this.disabled()) return;
    if (this.kind() === 'ssh' && this.step() === 'key') this.backRequested.emit();
    else this.cancelled.emit();
  }

  protected keydown(event: KeyboardEvent): void {
    // HostField owns its first Enter (pick/resolve). Textarea Enter remains an editing operation.
    if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    this.next();
  }
}
