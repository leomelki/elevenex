import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, OnChanges, output, signal, viewChild } from '@angular/core';
import { MACHINE_LAUNCH_OPEN } from './machine-launch-context';
import { LaunchRect, MachineLaunchMotion, measureLaunchRect } from './machine-launch-motion';

/** Owns view/focus lifetimes. Both projections stay mounted; the hidden view is inert. */
@Component({
  selector: 'ex-machine-launch',
  providers: [{ provide: MACHINE_LAUNCH_OPEN, useFactory: () => inject(MachineLaunchComponent).homeHeld }],
  templateUrl: './machine-launch.component.html',
  styleUrl: './machine-launch.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineLaunchComponent implements OnChanges {
  readonly open = input(false);
  readonly machineId = input<string | null>(null);
  readonly transitionFinished = output<boolean>();
  private readonly transitioning = signal(false);
  readonly homeHeld = computed(() => this.open() || this.transitioning());
  protected readonly host = viewChild<ElementRef<HTMLElement>>('host');
  protected readonly home = viewChild<ElementRef<HTMLElement>>('home');
  protected readonly pane = viewChild<ElementRef<HTMLElement>>('pane');
  protected readonly zoom = viewChild<ElementRef<HTMLElement>>('zoom');
  protected readonly faces = viewChild<ElementRef<HTMLElement>>('faces');
  private readonly destroyRef = inject(DestroyRef);
  private previous?: boolean;
  private lastMachine: string | null = null;
  private returnFocus?: HTMLElement;
  private from?: LaunchRect;
  private motion?: MachineLaunchMotion;
  private focusFrame?: number;

  constructor() {
    this.destroyRef.onDestroy(() => { this.motion?.dispose(); if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame); });
    afterRenderEffect(() => {
      const opening = this.open(), machine = this.machineId();
      if (machine) this.lastMachine = machine;
      const was = this.previous; this.previous = opening;
      if (was === undefined || was === opening) return;
      const host = this.host()?.nativeElement, pane = this.pane()?.nativeElement, zoom = this.zoom()?.nativeElement, home = this.home()?.nativeElement, faces = this.faces()?.nativeElement;
      if (!host || !pane || !zoom || !home || !faces) return;
      // The destination is interactive as soon as it opens. Focus must not
      // depend on an animation promise (which can be interrupted or reduced).
      if (this.focusFrame !== undefined) cancelAnimationFrame(this.focusFrame);
      if (opening) this.focusFrame = requestAnimationFrame(() => {
        this.focusFrame = undefined;
        // Projected components can clear their own inert state in the next
        // render pass. Focus after that pass, before the launch has finished.
        if (this.open() && !pane.contains(document.activeElement)) Array.from(pane.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]'))
          .find(element => !element.closest('[inert]') && getComputedStyle(element).visibility === 'visible')?.focus({ preventScroll: true });
      });
      this.motion ??= new MachineLaunchMotion({ host, home, pane, zoom, faces });
      const card = this.card(this.lastMachine), from = this.from; this.from = undefined;
      void this.motion.play(opening, card, opening ? from : undefined).then(completed => {
        if (!completed || this.destroyRef.destroyed) return;
        this.transitioning.set(false);
        const destination = opening ? pane : home;
        // Do not take focus back from a destination control reached during motion.
        if (!destination.contains(document.activeElement)) {
          if (!opening) (this.returnFocus?.isConnected ? this.returnFocus : card)?.focus({ preventScroll: true });
        }
        this.transitionFinished.emit(opening);
      });
    });
  }

  ngOnChanges(): void {
    if (this.previous !== undefined && this.open() !== this.previous) this.transitioning.set(true);
    if (this.open() && this.previous === false) {
      const host = this.host()?.nativeElement, home = this.home()?.nativeElement, card = this.card(this.machineId());
      if (host && card) this.from = measureLaunchRect(host, card);
      // Capture before inert hides the outgoing focused descendant.
      if (home?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) this.returnFocus = document.activeElement;
    }
  }

  private card(id: string | null): HTMLElement | undefined {
    return Array.from(this.home()?.nativeElement.querySelectorAll<HTMLElement>('[data-machine]') ?? []).find(element => element.dataset['machine'] === id);
  }
}
