import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
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

  constructor() { afterNextRender(() => this.animationsReady.set(true)); }

  protected selectedId(): string | undefined { return this.active() ?? this.items()[0]?.id; }
  protected keydown(event: KeyboardEvent, id: string): void {
    if (this.disabled()) return;
    const items = this.items();
    const index = items.findIndex(tab => tab.id === id);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Delete' && this.closable()) { event.preventDefault(); this.closed.emit(id); return; }
    else return;
    const tab = items[next];
    if (!tab) return;
    event.preventDefault();
    this.selected.emit(tab.id);
    this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  protected middleClick(event: MouseEvent, id: string): void {
    if (event.button === 1 && !this.disabled() && this.closable()) { event.preventDefault(); this.closed.emit(id); }
  }
}
