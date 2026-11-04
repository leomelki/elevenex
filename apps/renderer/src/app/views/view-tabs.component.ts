import { afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild, type AnimationCallbackEvent } from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../ui';
import { CdkDrag, CdkDragHandle, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ViewTab, type ViewTabMove } from './view.models';

/** Matches the strip's edge mask in view-tabs.component.css. */
const FADE_WIDTH = 24;

@Component({
  selector: 'ex-view-tabs',
  imports: [IconComponent, StatusGlyphComponent, CdkDrag, CdkDragHandle, CdkDropList],
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
  readonly reorderable = input(false);
  readonly detachable = input(false);
  readonly tabsBusy = input(false);
  readonly moved = output<ViewTabMove>();
  readonly windowRequested = output<string>();
  protected readonly announcement = signal('');
  private dragIds: readonly string[] = [];
  private dragCancelled = false;
  readonly selected = output<string>();
  readonly closed = output<string>();
  readonly added = output<void>();
  protected readonly animationsReady = signal(false);
  protected readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly itemIds = computed(() => JSON.stringify(this.items().map(item => item.id)));
  /** Edge fades show that tabs continue past either side of the strip. */
  protected readonly moreBefore = signal(false);
  protected readonly moreAfter = signal(false);
  private revealSelection = true;
  private layoutFrame = 0;
  private readonly newButton = viewChild<ElementRef<HTMLButtonElement>>('newButton');
  private pendingClose?: { id: string; index: number; focus: HTMLElement };
  private readonly exits = new Set<Animation>();
  protected readonly selectedId = computed(() => this.items().find(item => item.id === this.active())?.id ?? this.items()[0]?.id);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.layoutFrame);
      for (const animation of this.exits) animation.cancel();
    });
    afterNextRender(() => this.animationsReady.set(true));
    afterRenderEffect(() => {
      this.selectedId();
      this.revealSelection = true;
      this.layout(true);
    });
    afterRenderEffect((onCleanup) => {
      this.itemIds();
      const list = this.list()?.nativeElement;
      if (!list || typeof ResizeObserver === 'undefined') return;
      // Observe the animated shells too: a new tab starts at zero width, and
      // following its growth frame by frame already reads as a smooth slide.
      const observer = new ResizeObserver(() => this.scheduleLayout());
      observer.observe(list);
      for (const shell of list.children) observer.observe(shell);
      this.scheduleLayout();
      onCleanup(() => observer.disconnect());
    });
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

  private scheduleLayout(): void {
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => this.layout(false));
  }

  protected browseTabs(): void {
    // Manual browsing must remain possible while the selected tab is offscreen.
    this.revealSelection = false;
  }

  protected scrolled(): void {
    // Only refresh the fades here; revealing from scroll events would fight
    // the person's own scrolling and cancel smooth revelation.
    const list = this.list()?.nativeElement;
    if (list) this.updateEdges(list);
  }

  protected wheel(event: WheelEvent): void {
    const list = this.list()?.nativeElement;
    if (event.ctrlKey || !list || list.scrollWidth <= list.clientWidth) return;
    this.browseTabs();
    // Trackpads scroll horizontally on their own; map a plain mouse wheel too.
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    list.scrollLeft += event.deltaY * unit;
  }

  protected select(id: string): void {
    if (this.disabled()) return;
    this.selected.emit(id);
    // Reselecting the current tab settles manual browsing immediately, even
    // when a previous smooth reveal is still being interrupted.
    if (id === this.selectedId()) {
      this.revealSelection = true;
      this.layout(false);
    }
  }

  private layout(selectionChanged: boolean): void {
    const list = this.list()?.nativeElement;
    if (!list || !list.clientWidth) return;
    const selected = Array.from(list.children).find((shell): shell is HTMLElement => shell instanceof HTMLElement
      && !shell.hasAttribute('inert')
      && shell.querySelector<HTMLButtonElement>('[role="tab"]')?.dataset['tabId'] === this.selectedId());
    if (this.revealSelection && selected) this.revealTab(list, selected, selectionChanged);
    this.updateEdges(list);
  }

  private updateEdges(list: HTMLElement): void {
    this.moreBefore.set(list.scrollLeft > 1);
    this.moreAfter.set(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  }

  private revealTab(list: HTMLElement, shell: HTMLElement, smooth: boolean): void {
    const bounds = list.getBoundingClientRect(), tab = shell.getBoundingClientRect();
    // Keep the tab clear of the edge fade; the first/last tab clamps to the end.
    const inset = Math.min(FADE_WIDTH, Math.max(0, (bounds.width - tab.width) / 2));
    const delta = tab.left < bounds.left + inset ? tab.left - bounds.left - inset
      : Math.max(0, tab.right - bounds.right + inset);
    if (Math.abs(delta) <= 0.5) return;
    // Scroll only this strip; scrollIntoView can also move the workspace/chat.
    const behavior = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant';
    list.scrollBy({ left: delta, behavior });
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
    if (event.key === 'Escape' && this.dragIds.length) { this.dragCancelled = true; event.preventDefault(); event.stopPropagation(); return; }
    const items = this.items();
    const index = items.findIndex(tab => tab.id === id);
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault(); event.stopPropagation();
      if (this.reorderable() && !this.tabsBusy()) this.move(id, index + (event.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
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
    // Let focus settle before the after-render selection reveal.
    Array.from(this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find(button => button.dataset['tabId'] === tab.id && !button.closest('[inert]'))?.focus({ preventScroll: true });
    this.select(tab.id);
  }

  protected middleClick(event: MouseEvent, id: string): void {
    if (event.button === 1 && !this.disabled() && this.closable()) { event.preventDefault(); this.close(id); }
  }

  protected dragStarted(): void {
    this.dragIds = this.items().map(item => item.id);
    this.dragCancelled = false;
  }

  protected dropped(event: CdkDragDrop<unknown, unknown, string>): void {
    const ids = this.dragIds;
    this.dragIds = [];
    // A tab can close or arrive during a drag. Cancel rather than reinterpret old indices.
    if (this.dragCancelled || this.disabled() || this.tabsBusy() || JSON.stringify(ids) !== this.itemIds()) return;
    const id = event.item.data;
    if (event.isPointerOverContainer) {
      if (this.reorderable() && event.currentIndex !== event.previousIndex) this.move(id, event.currentIndex);
    } else if (this.detachable()) {
      const box = this.list()?.nativeElement.getBoundingClientRect();
      // Horizontal overflow is browsing, not tear-off. Require a deliberate vertical exit.
      if (box && (event.dropPoint.y < box.top - 48 || event.dropPoint.y > box.bottom + 48)) this.windowRequested.emit(id);
    }
  }

  private move(id: string, index: number): void {
    const items = this.items();
    if (index < 0 || index >= items.length || !items.some(item => item.id === id)) return;
    const remaining = items.filter(item => item.id !== id);
    this.moved.emit({ tabId: id, beforeTabId: remaining[index]?.id ?? null });
    this.announcement.set(`${items.find(item => item.id === id)?.title} moved to position ${index + 1} of ${items.length}`);
  }
}
