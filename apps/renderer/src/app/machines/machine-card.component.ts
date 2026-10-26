import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, EventEmitter, Output, afterRenderEffect, computed, inject, input, linkedSignal, output } from '@angular/core';
import { IconComponent, KbdComponent, ProgressLineComponent } from '../ui';
import { Machine, MachineOpenEvent, MachineMenuEvent, MACHINE_ICON, machineConnected } from './machine.models';

@Component({
  selector: 'ex-machine-card',
  imports: [IconComponent, KbdComponent, ProgressLineComponent],
  templateUrl: './machine-card.component.html',
  styleUrl: './machine-card.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineCardComponent {
  readonly machine = input.required<Machine>();
  readonly highlighted = input(false);
  readonly pressed = input(false);
  readonly disabled = input(false);
  readonly pending = input(false);
  readonly menuOpen = input(false);
  readonly menuEnabled = input(true);
  readonly leaving = input(false);
  @Output() readonly menuRequested = new EventEmitter<MachineMenuEvent>();
  readonly opened = output<MachineOpenEvent>();
  // EventEmitter exposes whether the optional action intent has an owner.
  @Output() readonly actionRequested = new EventEmitter<MachineOpenEvent>();
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private previous?: { id: string; busy: boolean };
  private nudge?: Animation;
  private menuTimer?: ReturnType<typeof setTimeout>;
  private stopMenuRelease?: () => void;
  protected readonly icons = MACHINE_ICON;
  protected readonly error = computed(() => this.machine().busy ? undefined : this.machine().error);
  protected readonly connected = computed(() => !this.machine().busy && !this.error() && machineConnected(this.machine()));
  protected readonly color = computed(() => this.machine().hue || this.machine().color ? `var(--project-${this.machine().hue || this.machine().color})` : 'var(--ink)');
  protected readonly settled = linkedSignal({
    source: () => ({ id: this.machine().id, busy: !!this.machine().busy, error: !!this.error() }),
    computation: ({ id, busy, error }, previous): boolean => !busy && !error && previous?.source.id === id && (previous.source.busy || previous.value),
  });
  protected readonly line = computed(() => ({
    key: this.error() ? `error-${this.error()!.step}` : this.machine().busy ? `busy-${this.machine().busy!.step}` : this.settled() ? 'ready' : 'initial',
    text: this.description(), meta: this.machine().busy?.meta,
  }));
  protected readonly description = computed(() => {
    const machine = this.machine();
    return this.error()?.step ?? machine.busy?.step ?? (machine.update ? `Had ${machine.update} · updates when opened` : this.connected() ? machine.status ?? 'Connected' : machine.last ?? 'Not connected');
  });

  constructor() {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => { if (media.matches) this.nudge?.cancel(); };
    media.addEventListener('change', cancel);
    afterRenderEffect(() => {
      const machine = this.machine();
      if (machine.busy || !machine.error || this.previous?.id !== machine.id) { this.nudge?.cancel(); this.nudge = undefined; }
      if (!machine.busy && machine.error && this.previous?.id === machine.id && this.previous.busy && !media.matches) {
        this.nudge?.cancel();
        const card = this.root.querySelector('button');
        if (card?.animate) {
          const style = getComputedStyle(card);
          const easing = style.getPropertyValue('--ease-out').trim();
          // CSS animation timing applies between keyframes. Easing the whole
          // WAAPI effect instead compresses the shake into its first few frames.
          this.nudge = card.animate([
            { transform: 'none', easing },
            { transform: 'translateX(-3px)', offset: .2, easing },
            { transform: 'translateX(3px)', offset: .45, easing },
            { transform: 'translateX(-1.5px)', offset: .7, easing },
            { transform: 'none' },
          ], { duration: parseFloat(style.getPropertyValue('--dur-deliberate')), easing: 'linear' });
        }
      }
      this.previous = { id: machine.id, busy: !!machine.busy };
    });
    inject(DestroyRef).onDestroy(() => { this.nudge?.cancel(); this.cancelMenu(); media.removeEventListener('change', cancel); });
  }

  private activate(newWindow: boolean): void {
    const event = { machine: this.machine(), newWindow };
    if (this.error() && this.actionRequested.observed) this.actionRequested.emit(event);
    else this.opened.emit(event);
  }

  protected open(event: MouseEvent): void {
    if (this.disabled()) return;
    this.activate(event.metaKey || event.ctrlKey);
  }

  protected keydown(event: KeyboardEvent): void {
    if (this.menuRequested.observed && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { this.menu(event, true); return; }
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || this.disabled()) return;
    // Native keyboard-generated clicks do not preserve the modifier keys.
    event.preventDefault();
    this.activate(true);
  }

  protected menu(event: MouseEvent | KeyboardEvent, fromButton = false): void {
    if (!this.menuEnabled() || !this.menuRequested.observed || this.disabled() || this.leaving()) return;
    event.preventDefault(); event.stopPropagation();
    const card = this.root.querySelector<HTMLElement>('[data-machine]');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const intent = { machine: this.machine(), card, fromButton,
      x: fromButton ? rect.right - 10 : event instanceof MouseEvent ? event.clientX : rect.right,
      y: fromButton ? rect.top + 40 : event instanceof MouseEvent ? event.clientY : rect.top + 40 };
    this.cancelMenu();
    if (!fromButton && event instanceof MouseEvent && event.buttons & 2) {
      // macOS dispatches contextmenu before release. Install the listener in
      // that same input handler so a render cannot miss pointerup. Otherwise
      // the opening auxclick would immediately dismiss a programmatic overlay.
      const release = () => {
        this.stopMenuRelease?.(); this.stopMenuRelease = undefined;
        this.menuTimer = setTimeout(() => { if (card.isConnected && !this.disabled() && !this.leaving()) this.menuRequested.emit(intent); }, 0);
      };
      card.ownerDocument.addEventListener('pointerup', release, { once: true });
      const cancel = () => this.cancelMenu();
      card.ownerDocument.addEventListener('pointercancel', cancel, { once: true });
      this.stopMenuRelease = () => { card.ownerDocument.removeEventListener('pointerup', release); card.ownerDocument.removeEventListener('pointercancel', cancel); };
    } else this.menuRequested.emit(intent);
  }

  private cancelMenu(): void {
    clearTimeout(this.menuTimer); this.menuTimer = undefined;
    this.stopMenuRelease?.(); this.stopMenuRelease = undefined;
  }
}
