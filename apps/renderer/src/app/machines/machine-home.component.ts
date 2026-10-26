import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, OnChanges, Output, afterRenderEffect, computed, ElementRef, inject, input, linkedSignal, model, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, IconComponent, KbdComponent } from '../ui';
import { MachineAddComponent } from './machine-add.component';
import { MachineCardComponent } from './machine-card.component';
import { MachineGridMotionDirective } from './machine-grid-motion.directive';
import { MACHINE_LAUNCH_OPEN } from './machine-launch-context';
import { Machine, MachineOpenEvent, MachineMenuEvent, machineConnected } from './machine.models';

type HomeEntry = { readonly key: string; readonly machine: Machine } | { readonly key: string; readonly label: string };

@Component({
  selector: 'ex-machine-home',
  imports: [ButtonComponent, IconComponent, KbdComponent, MachineCardComponent, MachineAddComponent, MachineGridMotionDirective],
  templateUrl: './machine-home.component.html',
  styleUrl: './machine-home.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineHomeComponent implements OnChanges {
  readonly machines = input<readonly Machine[]>([]);
  readonly highlighted = input<string>();
  readonly pressed = input<string>();
  readonly menuOpen = input<string | null>(null);
  @Output() readonly menuRequested = new EventEmitter<MachineMenuEvent>();
  readonly pending = input<string | readonly string[] | null>(null);
  readonly firstRun = input(false);
  readonly title = input<string>();
  readonly subtitle = input<string>();
  readonly ping = input<{ readonly id: string; readonly at: number } | null>(null);
  readonly findOpen = model(false);
  readonly findRequested = output<void>();
  @Output() readonly actionRequested = new EventEmitter<MachineOpenEvent>();
  readonly opened = output<MachineOpenEvent>();
  readonly addServer = output<HTMLElement>();
  readonly pairComputer = output<HTMLElement>();
  protected readonly query = signal('');
  private readonly exits = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retained = linkedSignal({
    source: this.machines,
    computation: (machines, previous): readonly { readonly machine: Machine; readonly leaving: boolean }[] => {
      const rows = machines.map(machine => ({ machine, leaving: false }));
      for (const [index, row] of (previous?.value ?? []).entries()) {
        if (!machines.some(machine => machine.id === row.machine.id)) rows.splice(index, 0, { ...row, leaving: true });
      }
      return rows;
    },
  });
  protected leaving(id: string): boolean { return this.retained().some(row => row.machine.id === id && row.leaving); }
  protected readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private pinged: { readonly id: string; readonly at: number } | null = null;
  private pingAnimations: Animation[] = [];
  private ring?: HTMLElement;
  private readonly launchOpen = inject(MACHINE_LAUNCH_OPEN, { optional: true });
  protected readonly held = computed(() => !!this.launchOpen?.());
  protected readonly showFirstRun = linkedSignal({ source: () => ({ firstRun: this.firstRun(), held: this.held() }), computation: ({ firstRun, held }, previous): boolean => held && previous ? previous.value : firstRun });
  protected readonly heading = computed(() => this.title() ?? (this.showFirstRun() ? 'Where should your agents run?' : 'Machines'));
  protected readonly description = computed(() => this.subtitle() ?? (this.showFirstRun() ? 'Open a machine to work on it. Add more any time: they all wait here.' : 'Pick where this window runs'));
  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.retained().map(row => row.machine).filter(machine => !query || `${machine.name} ${machine.address ?? ''}`.toLocaleLowerCase().includes(query));
  });
  // Placement is local interaction state. Keep an existing group while preparing,
  // pending or behind the machine view; release it when Home becomes visible.
  private readonly groups = linkedSignal({
    source: () => ({ machines: this.retained().map(row => row.machine), pending: this.pending(), held: this.held() }),
    computation: ({ machines, held }, previous): ReadonlyMap<string, boolean> => new Map(machines.map(machine => {
      const before = previous?.value.get(machine.id);
      return [machine.id, before !== undefined && (held || machine.busy || this.isPending(machine.id)) ? before : machineConnected(machine)];
    })),
  });
  protected readonly entries = computed<readonly HomeEntry[]>(() => {
    const machines = this.filtered();
    if (this.showFirstRun()) return machines.map(machine => ({ key: `machine:${machine.id}`, machine }));
    const entries: HomeEntry[] = [];
    for (const connected of [true, false]) {
      const group = machines.filter(machine => this.groups().get(machine.id) === connected);
      if (group.length) entries.push({ key: `group:${connected}`, label: connected ? 'Connected' : 'Not connected' }, ...group.map(machine => ({ key: `machine:${machine.id}`, machine })));
    }
    return entries;
  });
  protected readonly gridKeys = computed(() => this.entries().map(entry => entry.key), {
    equal: (previous, next) => previous.length === next.length && previous.every((key, index) => key === next[index]),
  });

  constructor() {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    afterRenderEffect(() => {
      const rows = this.retained();
      for (const [id, timer] of this.exits) if (!rows.some(row => row.machine.id === id && row.leaving)) { clearTimeout(timer); this.exits.delete(id); }
      for (const row of rows) if (row.leaving && !this.exits.has(row.machine.id)) {
        this.exits.set(row.machine.id, setTimeout(() => {
          this.exits.delete(row.machine.id);
          this.retained.update(current => current.filter(entry => entry.machine.id !== row.machine.id || !entry.leaving));
        }, media.matches || this.held() ? 0 : 260));
      }
    });
    const cancel = () => { if (media.matches) this.clearPing(); };
    media.addEventListener('change', cancel);
    afterRenderEffect(() => {
      const ping = this.ping();
      if (!ping || this.held() || this.pinged?.id === ping.id && this.pinged.at === ping.at) return;
      this.filtered();
      this.query.set('');
      this.clearPing();
      const card = Array.from(this.root.querySelectorAll<HTMLElement>('[data-machine]')).find(card => card.dataset['machine'] === ping.id);
      if (!card) return;
      this.pinged = ping;
      card.scrollIntoView?.({ block: 'center', behavior: media.matches ? 'instant' : 'smooth' });
      if (media.matches || !card.animate) return;
      const machine = this.machines().find(machine => machine.id === ping.id);
      const style = getComputedStyle(card);
      const duration = parseFloat(style.getPropertyValue('--dur-deliberate'));
      const tone = machine?.error ? machine.error.tone === 'danger' ? 'danger' : 'attention' : machine?.busy ? 'running' : 'accent';
      const ring = card.ownerDocument.createElement('span');
      ring.setAttribute('aria-hidden', 'true');
      Object.assign(ring.style, { position: 'absolute', inset: '0', borderRadius: 'inherit', border: `2px solid var(--${tone})`, pointerEvents: 'none' });
      card.append(ring); this.ring = ring;
      this.pingAnimations = [card.animate([{ scale: '1' }, { scale: '1.025', offset: .35 }, { scale: '1' }], { duration, easing: style.getPropertyValue('--ease-spring').trim() }),
        ring.animate([{ opacity: '.65', scale: '1' }, { opacity: '0', scale: '1.12' }], { duration: duration * 1.5, easing: style.getPropertyValue('--ease-out').trim() })];
      void Promise.all(this.pingAnimations.map(animation => animation.finished)).then(() => { if (this.ring === ring) this.clearPing(); }, () => undefined);
    });
    let wasFinding = false;
    afterRenderEffect(() => {
      const finding = this.findOpen();
      if (finding) this.findInput()?.nativeElement.focus({ preventScroll: true });
      else if (wasFinding) this.root.querySelector<HTMLButtonElement>('.find')?.focus({ preventScroll: true });
      wasFinding = finding;
    });
    inject(DestroyRef).onDestroy(() => { this.clearPing(); for (const timer of this.exits.values()) clearTimeout(timer); media.removeEventListener('change', cancel); });
  }

  private clearPing(): void { for (const animation of this.pingAnimations) animation.cancel(); this.pingAnimations = []; this.ring?.remove(); this.ring = undefined; }
  ngOnChanges(): void {
    const focused = this.root.ownerDocument.activeElement;
    const card = focused instanceof HTMLElement && this.root.contains(focused) ? focused.closest('ex-machine-card')?.querySelector<HTMLElement>('[data-machine]') : null;
    if (!card || this.machines().some(machine => machine.id === card.dataset['machine'])) return;
    // Move focus before the departing card becomes inert; prefer its neighbour.
    const cards = Array.from(this.root.querySelectorAll<HTMLElement>('[data-machine]'));
    const next = cards.slice(cards.indexOf(card) + 1).find(element => this.machines().some(machine => machine.id === element.dataset['machine']))
      ?? cards.filter(element => this.machines().some(machine => machine.id === element.dataset['machine'])).at(-1)
      ?? this.root.querySelector<HTMLElement>('.home');
    next?.focus({ preventScroll: true });
  }
  protected find(): void { this.findOpen.set(true); this.findRequested.emit(); }
  protected action(event: MachineOpenEvent): void {
    if (this.actionRequested.observed) this.actionRequested.emit(event);
    else this.opened.emit(event);
  }

  protected isPending(id: string): boolean {
    const pending = this.pending();
    return typeof pending === 'string' ? pending === id : !!pending?.includes(id);
  }

  protected add(event: MouseEvent, kind: 'ssh' | 'peer'): void {
    if (event.currentTarget instanceof HTMLElement) (kind === 'ssh' ? this.addServer : this.pairComputer).emit(event.currentTarget);
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (!this.showFirstRun() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      event.stopPropagation();
      this.find();
    }
    if (event.key === 'Escape' && this.findOpen()) { event.preventDefault(); this.query.set(''); this.findOpen.set(false); }
    if (event.key === 'Enter' && event.target === this.findInput()?.nativeElement) {
      const machines = this.entries().flatMap(entry => 'machine' in entry ? [entry.machine] : []);
      const machine = machines.find(item => item.id === this.highlighted()) ?? machines[0];
      if (machine) {
        event.preventDefault();
        const intent = { machine, newWindow: event.metaKey || event.ctrlKey };
        if (!machine.busy && machine.error) this.action(intent); else this.opened.emit(intent);
      }
    }
  }
}
