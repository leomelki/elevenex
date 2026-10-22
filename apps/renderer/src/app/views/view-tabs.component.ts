import { afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild, type AnimationCallbackEvent } from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../ui';
import { ViewTab } from './view.models';

@Component({
  selector: 'ex-view-tabs',
  imports: [IconComponent, StatusGlyphComponent],
  templateUrl: './view-tabs.component.html',
  styleUrl: './view-tabs.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewTabsComponent {
  readonly items = input<readonly ViewTab[]>([]);
  readonly active = input<string>();
  readonly label = input('View tabs');
  readonly newLabel = input('New tab');
  readonly closable = input(true);
  readonly disabled = input(false);
  readonly selected = output<string>();
  readonly closed = output<string>();
  readonly added = output<void>();
  protected readonly animationsReady = signal(false);
  protected readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly newButton = viewChild<ElementRef<HTMLButtonElement>>('newButton');
  private pendingClose?: { id: string; index: number; focus: HTMLElement };
  private readonly exits = new Set<Animation>();
  protected readonly selectedId = computed(() => this.items().find(item => item.id === this.active())?.id ?? this.items()[0]?.id);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const animation of this.exits) animation.cancel();
    });
    afterNextRender(() => this.animationsReady.set(true));
    afterRenderEffect(() => {
      const items = this.items();
      const pending = this.pendingClose;
      if (!pending || items.some(item => item.id === pending.id)) return;
      this.pendingClose = undefined;
      // A delayed close must not steal focus if the person has moved elsewhere.
      if (document.activeElement !== pending.focus && document.activeElement !== document.body) return;
      const next = items[Math.min(pending.index, items.length - 1)];
      const tab = Array.from(this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
        .find(button => button.dataset['tabId'] === next?.id);
      (tab ?? this.newButton()?.nativeElement)?.focus({ preventScroll: true });
    });
  }

  protected leave(event: AnimationCallbackEvent): void {
    // Angular retains the shell during its exit; remove its controls from keyboard navigation immediately.
    event.target.setAttribute('inert', '');
    event.target.setAttribute('aria-hidden', 'true');
    event.target.classList.add('leave');
    const animations = event.target.getAnimations?.() ?? [];
    if (!animations.length) {
      event.animationComplete();
      return;
    }
    for (const animation of animations) this.exits.add(animation);
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      for (const animation of animations) this.exits.delete(animation);
      event.animationComplete();
    });
  }

  protected close(id: string): void {
    if (this.disabled() || !this.closable()) return;
    const focus = document.activeElement;
    const tab = Array.from(this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find(button => button.dataset['tabId'] === id);
    if (focus instanceof HTMLElement && tab?.parentElement?.contains(focus)) {
      this.pendingClose = { id, index: this.items().findIndex(item => item.id === id), focus };
    }
    this.closed.emit(id);
  }
  protected keydown(event: KeyboardEvent, id: string): void {
    if (this.disabled()) return;
    const items = this.items();
    const index = items.findIndex(tab => tab.id === id);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Delete' && this.closable()) { event.preventDefault(); this.close(id); return; }
    else return;
    const tab = items[next];
    if (!tab) return;
    event.preventDefault();
    this.selected.emit(tab.id);
    Array.from(this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find(button => button.dataset['tabId'] === tab.id && !button.closest('[inert]'))?.focus();
  }

  protected middleClick(event: MouseEvent, id: string): void {
    if (event.button === 1 && !this.disabled() && this.closable()) { event.preventDefault(); this.close(id); }
  }
}
