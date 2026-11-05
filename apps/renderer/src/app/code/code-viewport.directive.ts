import { DOCUMENT } from '@angular/common';
import { afterNextRender, afterRenderEffect, DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { codeDestinationWidth, codeTransitionClock, supportsCodeTransition } from './code-view-transition';

/** Resize the live viewport once, then fit browser-owned snapshots to the
 * shell's glide without transforming the live iframe. One clock owns the blend.
 * Ordinary window resizing remains live. No iframe is recreated. */
@Directive({ selector: '[exCodeViewport]' })
export class CodeViewportDirective {
  readonly viewportWidth = output<number>();
  readonly layoutRequested = output<void>();
  readonly layoutReady = input(true);
  readonly contextKey = input('');
  readonly active = input(true);
  private readonly settlement = signal(0);
  private revealWhenReady?: () => void;
  private resetContext?: () => void;
  private suspendViewport?: () => void;
  private previousContext?: string;
  private previousActive?: boolean;
  private readonly frame = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);

  constructor() {
    let dispose: (() => void) | undefined;
    afterNextRender(() => { dispose = this.observe(); });
    afterRenderEffect(() => {
      const context = this.contextKey();
      const active = this.active();
      if (this.previousContext !== undefined && this.previousContext !== context) this.resetContext?.();
      else if (this.previousActive !== undefined && this.previousActive !== active) {
        if (active) this.resetContext?.();
        else this.suspendViewport?.();
      }
      this.previousContext = context;
      this.previousActive = active;
      this.settlement();
      if (active && this.layoutReady()) this.revealWhenReady?.();
    });
    inject(DestroyRef).onDestroy(() => dispose?.());
  }

  private observe(): () => void {
    const viewport = this.frame.parentElement;
    const window = this.document.defaultView;
    if (!viewport || !window) return () => undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Keep panel actions outside the snapshot's hit-test boundary.
    const scope = this.frame;
    const transitions = new Set<HTMLElement>();
    let width = viewport.clientWidth;
    let frozenWidth = 0;
    let pending = 0;
    let reveal = 0;
    let awaitingLayout = false;
    let snapshot: ViewTransition | undefined;
    let preparedWidth = 0;
    let generation = 0;
    let blendAncestor: HTMLElement | undefined;
    // Angular prefixes component keyframes in production builds.
    const snapshotAnimations = () => (scope.getAnimations?.({subtree: true}) ?? []).filter(animation =>
      'animationName' in animation && typeof animation.animationName === 'string'
      && /code-layout-(out|in)$/.test(animation.animationName));
    const playSnapshots = () => {
      if (!blendAncestor) return;
      const clock = codeTransitionClock(blendAncestor);
      for (const animation of snapshotAnimations()) {
        animation.effect?.updateTiming({ duration: clock.duration, delay: 0 });
        animation.play();
        // Native snapshot capture takes a few frames. Join the panel's existing
        // timeline instead of starting a second animation after capture/layout.
        if (clock.startTime !== null) animation.startTime = clock.startTime;
        else animation.currentTime = clock.elapsed;
      }
    };

    const cancelSnapshot = () => {
      generation++;
      snapshot?.skipTransition();
      snapshot = undefined;
      blendAncestor = undefined;
      preparedWidth = 0;
      this.frame.classList.remove('crossfading');
    };

    const cancelReveal = () => {
      window.cancelAnimationFrame(reveal);
      reveal = 0;
    };

    const measure = () => {
      if (!this.active()) return;
      const next = viewport.clientWidth;
      if (!frozenWidth && next > 0) {
        width = next;
        // Only the child owns a fixed width. The snapshot scope follows CSS
        // panel geometry, so an old child paint can never be magnified live.
        this.frame.style.setProperty('--code-viewport-width', `${width}px`);
        this.viewportWidth.emit(width);
      }
    };
    const release = () => {
      if (preparedWidth && Math.abs(viewport.clientWidth - preparedWidth) <= 1) {
        frozenWidth = 0;
        this.frame.classList.remove('resizing');
        measure();
        return;
      }
      // A native window resize can change a percentage destination mid-glide.
      // Reconcile that exceptional size under an immediate cover, not a flash.
      if (preparedWidth) this.frame.classList.add('reflowing', 'cover-immediate');
      cancelSnapshot();
      frozenWidth = 0;
      this.frame.classList.remove('resizing');
      measure();
      cancelReveal();
      awaitingLayout = true;
      this.layoutRequested.emit();
      this.settlement.update(value => value + 1);
    };
    this.revealWhenReady = () => {
      if (!awaitingLayout || reveal) return;
      if (preparedWidth) {
        // Child acknowledgement still owns focus/error handling. It must not
        // restart or extend the shell-owned visual transition.
        awaitingLayout = false;
        return;
      }
      if (frozenWidth) return;
      // Main acknowledges the expected child viewport, upstream compact-mode
      // commands and quiet workbench geometry before the reveal can begin.
      reveal = window.requestAnimationFrame(() => {
        reveal = 0;
        awaitingLayout = false;
        this.frame.classList.remove('reflowing', 'cover-immediate');
      });
    };
    const changed = (event: Event) => {
      const ancestor = event.target;
      // Listen on the document because transition events do not travel down to
      // projected content. Unrelated widths, opacity and nested effects cannot
      // hold the editor's viewport. No shell-private selectors are needed.
      if (!('propertyName' in event) || event.propertyName !== 'width' || !(ancestor instanceof HTMLElement) || ancestor === this.frame || !ancestor.contains(viewport)) return;
      if (!this.active()) return;
      if (event.type === 'transitionrun') {
        // Use the last settled measurement: reading layout here would flush
        // the first animated width into the child before we can freeze it.
        if (reduced.matches || width <= 0 || this.frame.hidden) return;
        transitions.add(ancestor);
        if (preparedWidth) { cancelSnapshot(); frozenWidth = 0; }
        if (!frozenWidth && width > 0) {
          cancelReveal();
          cancelSnapshot();
          awaitingLayout = false;
          frozenWidth = width;
          this.frame.style.setProperty('--code-viewport-width', `${width}px`);
          this.frame.classList.add('resizing');
          const destination = typeof KeyframeEffect === 'undefined' ? null : codeDestinationWidth(ancestor, viewport);
          if (destination === width) {
            // Sliding a panel over its retained viewport is not an editor
            // resize. Keep Code visible from the very first opening frame.
            transitions.delete(ancestor);
            frozenWidth = 0;
            this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
            return;
          }
          if (destination && supportsCodeTransition(scope)) {
            const version = generation;
            preparedWidth = destination;
            blendAncestor = ancestor;
            this.frame.classList.add('crossfading');
            const transition = scope.startViewTransition(async () => {
              if (version !== generation) return;
              // Lay out at the destination immediately, behind the old native
              // snapshot. Main's compact commands now overlap the panel glide.
              this.frame.style.setProperty('--code-viewport-width', `${destination}px`);
              width = destination;
              this.viewportWidth.emit(width);
              awaitingLayout = true;
              this.layoutRequested.emit();
              this.settlement.update(value => value + 1);
              // Return immediately so Chromium can propagate the new iframe
              // viewport. Holding this callback would suppress that layout.
            });
            snapshot = transition;
            void transition.ready.then(() => {
              if (snapshot !== transition) return;
              if (this.active()) playSnapshots();
            }).catch(() => { if (snapshot === transition) this.frame.classList.add('reflowing'); });
            void transition.finished.finally(() => {
              if (snapshot !== transition) return;
              snapshot = undefined;
              this.frame.classList.remove('crossfading', 'reflowing', 'cover-immediate');
            }).catch(() => undefined);
          } else this.frame.classList.add('reflowing');
        }
      } else {
        if (!transitions.delete(ancestor)) return;
        window.cancelAnimationFrame(pending);
        // A reversal cancels one transition and starts its replacement in the
        // same rendering update. Keep the original viewport through that pair.
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          if (!transitions.size) release();
        });
      }
    };
    const motionChanged = () => {
      if (!reduced.matches) return;
      transitions.clear();
      cancelSnapshot();
      window.cancelAnimationFrame(pending);
      pending = 0;
      release();
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    this.suspendViewport = () => {
      // Preserve the currently painted editor (even halfway through a resize)
      // while the shell clips it away. Platform actions are already inactive.
      transitions.clear();
      window.cancelAnimationFrame(pending); pending = 0;
      cancelReveal();
      awaitingLayout = false;
      for (const animation of snapshotAnimations()) animation.pause();
    };
    this.resetContext = () => {
      transitions.clear();
      window.cancelAnimationFrame(pending); pending = 0;
      cancelReveal(); cancelSnapshot();
      frozenWidth = 0; awaitingLayout = false;
      this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
      measure();
    };
    observer?.observe(viewport);
    measure();
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.addEventListener(type, changed, true);
    reduced.addEventListener('change', motionChanged);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(pending);
      cancelReveal();
      cancelSnapshot();
      this.revealWhenReady = undefined;
      this.resetContext = undefined;
      this.suspendViewport = undefined;
      for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) this.document.removeEventListener(type, changed, true);
      reduced.removeEventListener('change', motionChanged);
      this.frame.style.removeProperty('--code-viewport-width');
      this.frame.classList.remove('resizing', 'reflowing', 'cover-immediate');
    };
  }
}
