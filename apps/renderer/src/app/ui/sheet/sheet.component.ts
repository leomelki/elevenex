import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed, contentChildren, inject, input, output, signal, viewChild } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { ModalLayerComponent } from './modal-layer.component';
import { SheetSectionDirective, type SheetSection } from './sheet-section.directive';

@Component({
  selector: 'ex-sheet',
  imports: [NgTemplateOutlet, ModalLayerComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sheet.component.html',
  styleUrl: './sheet.component.css',
})
export class SheetComponent {
  readonly open = input(false);
  readonly label = input('Settings');
  readonly section = input<string>();
  readonly sections = input<readonly SheetSection[]>([]);
  readonly page = input<string>();
  readonly closeRequested = output<void>();
  readonly sectionChanged = output<string>();
  private readonly projectedSections = contentChildren(SheetSectionDirective);
  protected readonly items = computed<readonly SheetSection[]>(() => this.sections().length ? this.sections() : this.projectedSections().map(section => ({
    id: section.id(), label: section.label(), icon: section.icon(), count: section.count(), content: section.content,
  })));
  protected readonly active = signal<string | undefined>(undefined);
  protected readonly resizing = signal(false);
  protected readonly listThumb = signal<{ top: number; width: number; height: number } | undefined>(undefined);
  protected readonly tabThumb = signal<{ left: number; width: number } | undefined>(undefined);
  private readonly scroll = viewChild<ElementRef<HTMLElement>>('scroll');
  private readonly tabs = viewChild<ElementRef<HTMLElement>>('tabs');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private observer?: ResizeObserver;
  private observedScroll?: HTMLElement;
  private pageAnimation?: Animation;
  private locked = false;
  private initialKey = '';
  private resizeFrame?: number;
  private lastPage?: string;

  constructor() {
    afterRenderEffect(() => {
      const scroll = this.scroll()?.nativeElement;
      const sections = this.items();
      if (!this.open() || !scroll) {
        this.initialKey = '';
        this.observer?.disconnect();
        this.observedScroll = undefined;
        this.pageAnimation?.cancel();
        cancelAnimationFrame(this.resizeFrame ?? 0);
        return;
      }
      const page = this.page();
      if (!sections.length) {
        if (page !== this.lastPage && this.lastPage !== undefined && !this.reduced() && scroll.animate) {
          this.pageAnimation?.cancel();
          this.pageAnimation = scroll.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.16,1,.3,1)' });
        }
        this.lastPage = page;
        return;
      }
      const key = this.section() ?? sections[0]!.id;
      if (this.initialKey !== key) {
        this.initialKey = key;
        if (key === sections[0]!.id) {
          scroll.scrollTop = 0;
          this.active.set(key);
          this.locked = false;
        } else this.go(key, true);
      }
      this.active();
      this.measure();
      if (typeof ResizeObserver !== 'undefined' && this.observedScroll !== scroll) {
        this.observer?.disconnect();
        this.observedScroll = scroll;
        this.observer = new ResizeObserver(() => {
          cancelAnimationFrame(this.resizeFrame ?? 0);
          this.resizing.set(true);
          this.measure();
          this.resizeFrame = requestAnimationFrame(() => this.resizing.set(false));
        });
        this.observer.observe(scroll);
        if (this.list()) this.observer.observe(this.list()!.nativeElement);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.pageAnimation?.cancel();
      cancelAnimationFrame(this.resizeFrame ?? 0);
    });
  }

  protected go(id: string, instant = false): void {
    const scroll = this.scroll()?.nativeElement;
    const element = this.sectionElement(id);
    if (!scroll || !element) return;
    this.active.set(id);
    this.sectionChanged.emit(id);
    this.locked = true;
    const top = Math.max(0, element.offsetTop - this.tabsHeight() - 8);
    if (instant || this.reduced() || typeof scroll.scrollTo !== 'function') scroll.scrollTop = top;
    else scroll.scrollTo({ top, behavior: 'smooth' });
  }

  protected unlock(): void { this.locked = false; }

  protected spy(): void {
    const scroll = this.scroll()?.nativeElement;
    const items = this.items();
    if (!scroll || this.locked || !items.length) return;
    let active = items[0]!.id;
    for (const item of items) {
      const element = this.sectionElement(item.id);
      if (element && element.offsetTop - this.tabsHeight() - 40 <= scroll.scrollTop) active = item.id;
    }
    if (scroll.scrollTop > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) active = items.at(-1)!.id;
    if (active !== this.active()) {
      this.active.set(active);
      this.sectionChanged.emit(active);
    }
  }

  protected tabKey(event: KeyboardEvent, index: number): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    const items = this.items();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + direction + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    this.go(item.id);
    this.tabs()?.nativeElement.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  private sectionElement(id: string): HTMLElement | undefined {
    return Array.from(this.scroll()?.nativeElement.querySelectorAll<HTMLElement>('[data-sheet-sec]') ?? []).find(element => element.dataset['sheetSec'] === id);
  }
  private tabsHeight(): number { return this.tabs()?.nativeElement.offsetHeight ?? 0; }
  private reduced(): boolean { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
  private measure(): void {
    const listItem = this.list()?.nativeElement.querySelector<HTMLElement>('[aria-current="true"]');
    const tab = this.tabs()?.nativeElement.querySelector<HTMLElement>('[aria-current="true"]');
    if (listItem) this.listThumb.set({ top: listItem.offsetTop, width: listItem.offsetWidth, height: listItem.offsetHeight });
    if (tab) this.tabThumb.set({ left: tab.offsetLeft, width: tab.offsetWidth });
  }
}
