import { ScrollingModule } from '@angular/cdk/scrolling';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent, IconButtonComponent } from '../ui';
import { TerminalFailure, TerminalFailureEvent, TerminalLine, TerminalScript, TerminalTab } from './view.models';
import { ViewTabsComponent } from './view-tabs.component';
import { TerminalLauncherComponent } from './terminal-launcher.component';

@Component({
  selector: 'ex-terminal-view',
  imports: [ButtonComponent, FoldComponent, IconComponent, IconButtonComponent, ViewTabsComponent, TerminalLauncherComponent, ScrollingModule],
  templateUrl: './terminal-view.component.html',
  styleUrl: './terminal-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalViewComponent {
  readonly tabs = input<readonly TerminalTab[]>([]);
  readonly active = input<string>();
  readonly disabled = input(false);
  readonly animateTabs = input(true);
  readonly askDisabled = input(false);
  readonly rerunDisabled = input(false);
  readonly findStatus = input('');
  readonly findMatches = input<number | null>(null);
  readonly searchRequested = output<{ query: string; backwards: boolean }>();
  readonly scripts = input<readonly TerminalScript[]>([]);
  readonly output = input<readonly TerminalLine[]>([]);
  readonly failure = input<TerminalFailure | null>(null);
  readonly selected = output<string>();
  readonly closed = output<string>();
  readonly added = output<void>();
  readonly scriptRequested = output<TerminalScript>();
  readonly askRequested = output<TerminalFailureEvent>();
  readonly rerunRequested = output<TerminalFailureEvent>();
  readonly portOpened = output<number>();
  readonly stopRequested = output<string>();
  readonly findRequested = output<void>();
  protected readonly current = computed(() => this.tabs().find(tab => tab.id === this.active()) ?? this.tabs()[0]);
  protected readonly findOpen = signal(false);
  protected readonly query = signal('');
  protected readonly toolbarOpen = computed(() => this.findOpen() || this.current()?.status === 'serving');
  protected readonly preview = computed(() => {
    const query = this.query().toLocaleLowerCase();
    return this.output().slice(-2000).filter(line => !query || line.text.toLocaleLowerCase().includes(query));
  });
  protected readonly omitted = computed(() => Math.max(0, this.output().length - 2000));
  protected readonly trackLine = (_index: number, line: TerminalLine): string => line.id;
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  private readonly findBar = viewChild<ElementRef<HTMLElement>>('findBar');
  private findWasOpen = false;
  private returnFocus?: HTMLElement;
  private restoreFindFocus = false;

  constructor() {
    afterRenderEffect(() => {
      const open = this.findOpen();
      const input = this.findInput()?.nativeElement;
      if (open && !this.findWasOpen && input) {
        input.focus({ preventScroll: true });
      }
      if (!open && this.restoreFindFocus) {
        this.restoreFindFocus = false;
        if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
      }
      this.findWasOpen = open;
    });
  }

  protected searchKey(event: KeyboardEvent): void { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.search(this.query(), event.shiftKey); } }
  protected search(query: string, backwards = false): void { this.query.set(query); this.searchRequested.emit({ query, backwards }); }
  protected script(script: TerminalScript): void {
    if (!this.disabled()) this.scriptRequested.emit(script);
  }
  protected openPort(): void {
    const port = this.current()?.port;
    if (port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535) this.portOpened.emit(port);
  }
  protected failureAction(kind: 'ask' | 'rerun'): void {
    const tab = this.current();
    const failure = this.failure();
    if (!tab || !failure) return;
    const event = { tabId: tab.id, failure };
    if (kind === 'ask') this.askRequested.emit(event);
    else this.rerunRequested.emit(event);
  }
  protected find(): void {
    if (this.findOpen()) this.closeFind();
    else {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.findOpen.set(true);
    }
    this.findRequested.emit();
  }
  protected closeFind(): void {
    // Restore after rendering so focus never remains inside a closing fold.
    this.restoreFindFocus = this.findBar()?.nativeElement.contains(document.activeElement) ?? false;
    this.findOpen.set(false);
    this.query.set('');
    this.searchRequested.emit({ query: '', backwards: false });
  }
  protected keydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') { event.preventDefault(); if (!this.disabled()) this.added.emit(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (!this.findOpen()) this.find();
      else { this.findInput()?.nativeElement.focus({ preventScroll: true }); this.findInput()?.nativeElement.select(); }
    }
    if (event.key === 'Escape' && this.findOpen()) { event.preventDefault(); event.stopPropagation(); this.closeFind(); }
  }
}
