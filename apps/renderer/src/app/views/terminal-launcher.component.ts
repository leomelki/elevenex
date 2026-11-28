import { CdkConnectedOverlay, CdkOverlayOrigin, type ConnectedPosition } from '@angular/cdk/overlay';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { TerminalScript } from './view.models';

/** Bounds rendering for repositories with very large script catalogs; the field narrows the rest. */
const VISIBLE_SCRIPTS = 50;

type LaunchOption =
  | { readonly kind: 'shell'; readonly id: string }
  | { readonly kind: 'script'; readonly id: string; readonly script: TerminalScript };

let nextLauncherId = 0;

/**
 * Searchable launcher beside a tab strip's New button: a new shell or one of the
 * project's scripts. A specialized combobox dialog rather than a menu because it
 * holds a text field; the owner performs the launch.
 */
@Component({
  selector: 'ex-terminal-launcher',
  imports: [CdkConnectedOverlay, CdkOverlayOrigin, IconComponent, KbdComponent],
  templateUrl: './terminal-launcher.component.html',
  styleUrl: './terminal-launcher.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalLauncherComponent {
  readonly scripts = input<readonly TerminalScript[]>([]);
  readonly disabled = input(false);
  readonly shellRequested = output<void>();
  readonly scriptRequested = output<TerminalScript>();

  protected readonly listId = `ex-terminal-launcher-${nextLauncherId++}`;
  private readonly requested = signal(false);
  /** Disabling a retained launcher releases its overlay at once. */
  protected readonly open = computed(() => this.requested() && !this.disabled());
  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 4 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
  ];
  private readonly matches = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return query ? this.scripts().filter(script => `${script.name} ${script.cmd}`.toLocaleLowerCase().includes(query)) : this.scripts();
  });
  protected readonly visibleScripts = computed(() => this.matches().slice(0, VISIBLE_SCRIPTS));
  protected readonly hiddenCount = computed(() => this.matches().length - this.visibleScripts().length);
  protected readonly showShell = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return !query || 'new shell terminal'.includes(query);
  });
  protected readonly options = computed<readonly LaunchOption[]>(() => [
    ...(this.showShell() ? [{ kind: 'shell', id: `${this.listId}-shell` } as const] : []),
    ...this.visibleScripts().map((script, index) => ({ kind: 'script', id: `${this.listId}-script-${index}`, script } as const)),
  ]);
  protected readonly activeId = computed(() => this.options()[this.activeIndex()]?.id ?? null);

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    afterRenderEffect(() => {
      if (this.open()) this.field()?.nativeElement.focus({ preventScroll: true });
    });
    afterRenderEffect(() => {
      const id = this.activeId();
      if (id) this.list()?.nativeElement.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  protected toggle(): void {
    if (this.open()) this.close(true);
    else if (!this.disabled()) {
      this.query.set('');
      this.activeIndex.set(0);
      this.requested.set(true);
    }
  }

  protected filter(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.options().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) this.activeIndex.update(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      const option = this.options()[this.activeIndex()];
      if (option) this.choose(option);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      // The overlay is portaled, so Tab would otherwise leave for the end of the document.
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    }
  }

  protected choose(option: LaunchOption): void {
    // Return focus first: the owner moves it on to the new terminal once attached.
    this.close(true);
    if (option.kind === 'shell') this.shellRequested.emit();
    else this.scriptRequested.emit(option.script);
  }

  protected close(restoreFocus: boolean): void {
    if (!this.requested()) return;
    this.requested.set(false);
    if (restoreFocus) this.trigger().nativeElement.focus({ preventScroll: true });
  }
}
