import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  SimpleChanges,
  afterRenderEffect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FlipDirective, IconComponent } from '../../ui';
import type { PanelTab } from '../task.models';
@Component({
  selector: 'ex-panel-tabs',
  imports: [IconComponent, FlipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './panel-tabs.component.html',
  styleUrl: './panel-tabs.component.css',
})
export class PanelTabsComponent implements OnChanges {
  readonly tabs = input<readonly PanelTab[]>([]);
  readonly active = input.required<string>();
  readonly labelled = input(false);
  readonly label = input('Side views');
  readonly selectTab = output<string>();
  protected readonly animateLabels = signal(false);
  protected readonly thumb = signal<{ left: number; width: number } | null>(
    null,
  );
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    afterRenderEffect({
      earlyRead: () => {
        this.active();
        this.labelled();
        this.tabs();
        const active = this.root.querySelector<HTMLElement>(
          '[aria-selected="true"]',
        );
        return active
          ? { left: active.offsetLeft, width: active.offsetWidth }
          : null;
      },
      write: (box) => {
        this.thumb.set(box());
      },
    });
  }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['active'] && !changes['active'].firstChange) this.animateLabels.set(true);
  }
  protected onKey(event: KeyboardEvent, index: number): void {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % this.tabs().length;
    else if (event.key === 'ArrowLeft')
      next = (index - 1 + this.tabs().length) % this.tabs().length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.tabs().length - 1;
    else return;
    event.preventDefault();
    const tab = this.tabs()[next];
    if (!tab) return;
    this.selectTab.emit(tab.id);
    const buttons =
      this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[next]?.focus();
  }
}
