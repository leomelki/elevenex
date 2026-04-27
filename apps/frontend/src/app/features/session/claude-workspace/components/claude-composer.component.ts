import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideSend, lucideSquare } from '@ng-icons/lucide';
import { ClaudeAutocompleteItem } from '@/shared/models/claude-runtime.model';

interface Range {
  start: number;
  end: number;
}

@Component({
  selector: 'cw-composer',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:mousedown)': 'onDocumentMousedown($event)',
  },
  viewProviders: [provideIcons({ lucideLoaderCircle, lucideSend, lucideSquare })],
  template: `
    <div class="cw-comp">
      @if (autocompleteOpen() && filtered().length) {
        <div class="cw-comp__ac" role="listbox">
          @for (item of filtered(); track item.id; let i = $index) {
            <button
              type="button"
              class="cw-comp__ac-item"
              [class.cw-comp__ac-item--active]="i === selectedIndex()"
              (mouseenter)="selectedIndex.set(i)"
              (mousedown)="$event.preventDefault(); apply(item)"
            >
              <span class="cw-comp__ac-label">{{ item.label }}</span>
              <span class="cw-comp__ac-kind">{{ item.kind }}</span>
              <span class="cw-comp__ac-desc">{{ item.description }}</span>
            </button>
          }
        </div>
      }

      <div class="cw-comp__box">
        <textarea
          #input
          class="cw-comp__ta"
          [placeholder]="placeholder()"
          [ngModel]="value()"
          (input)="onInput($event)"
          (click)="refreshAc($any($event.target))"
          (keydown)="onKeydown($event)"
          rows="1"
        ></textarea>

        <div class="cw-comp__bar">
          <span class="cw-comp__hint">
            @if (autocompleteOpen() && filtered().length) {
              ↑↓ navigate · ↵ insert
            } @else {
              / commands · $ skills · ⌘↵ send
            }
          </span>

          @if (running()) {
            <button
              type="button"
              class="cw-comp__btn cw-comp__btn--stop"
              [disabled]="!canInterrupt()"
              (click)="interrupt.emit()"
              title="Interrupt"
            >
              <ng-icon name="lucideSquare" size="14" />
              Stop
            </button>
          } @else {
            <button
              type="button"
              class="cw-comp__btn cw-comp__btn--send"
              [disabled]="!value().trim() || submitting()"
              (click)="submit()"
            >
              @if (submitting()) {
                <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
              } @else {
                <ng-icon name="lucideSend" size="14" />
              }
              Send
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
      }
      .cw-comp {
        position: relative;
      }
      .cw-comp__box {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        background: var(--background);
        box-shadow: 0 1px 0 color-mix(in oklab, var(--foreground) 4%, transparent);
        overflow: hidden;
      }
      .cw-comp__box:focus-within {
        border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 12%, transparent);
      }
      .cw-comp__ta {
        width: 100%;
        min-height: 2.75rem;
        max-height: 16rem;
        padding: 0.625rem 0.875rem 0.25rem;
        background: transparent;
        border: 0;
        outline: none;
        resize: none;
        color: inherit;
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.5;
      }
      .cw-comp__bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.375rem 0.625rem 0.375rem 0.875rem;
      }
      .cw-comp__hint {
        font-size: 0.6875rem;
        color: var(--muted-foreground);
      }
      .cw-comp__btn {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.3125rem 0.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
      }
      .cw-comp__btn--send {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-comp__btn--send:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .cw-comp__btn--stop {
        background: color-mix(in oklab, var(--destructive) 10%, var(--background));
        color: var(--destructive);
        border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
      }
      .cw-comp__btn--stop:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .cw-comp__ac {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 0.375rem);
        max-height: 18rem;
        overflow: auto;
        background: var(--popover);
        color: var(--popover-foreground);
        border: 1px solid var(--border);
        border-radius: 0.625rem;
        box-shadow: 0 10px 30px -10px color-mix(in oklab, #000 20%, transparent);
        z-index: 20;
      }
      .cw-comp__ac-item {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 0.5rem;
        align-items: baseline;
        width: 100%;
        padding: 0.4375rem 0.75rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        text-align: left;
        font-size: 0.8125rem;
      }
      .cw-comp__ac-item--active,
      .cw-comp__ac-item:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-comp__ac-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 600;
      }
      .cw-comp__ac-kind {
        font-size: 0.6875rem;
        text-transform: uppercase;
        color: var(--muted-foreground);
        letter-spacing: 0.04em;
      }
      .cw-comp__ac-desc {
        color: var(--muted-foreground);
        font-size: 0.75rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class ClaudeComposerComponent {
  @ViewChild('input', { static: true }) private ta!: ElementRef<HTMLTextAreaElement>;
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly value = input<string>('');
  readonly submitting = input<boolean>(false);
  readonly running = input<boolean>(false);
  readonly canInterrupt = input<boolean>(false);
  readonly autocompleteItems = input<ClaudeAutocompleteItem[]>([]);
  readonly placeholderText = input<string>('Tell Claude what to do…');

  readonly send = output<string>();
  readonly valueChange = output<string>();
  readonly interrupt = output<void>();

  readonly activeTrigger = signal<'/' | '$' | null>(null);
  readonly activeQuery = signal('');
  readonly autocompleteOpen = signal(false);
  readonly selectedIndex = signal(0);
  private range: Range | null = null;

  readonly filtered = computed(() => {
    const trigger = this.activeTrigger();
    if (!trigger) return [];
    const q = this.activeQuery().toLowerCase();
    return this.autocompleteItems()
      .filter((i) => i.trigger === trigger)
      .map((i) => ({ i, score: score(i, q) }))
      .filter((x) => x.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score || a.i.label.localeCompare(b.i.label))
      .map((x) => x.i)
      .slice(0, 10);
  });

  readonly placeholder = computed(() => this.placeholderText());

  onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    this.valueChange.emit(ta.value);
    this.autoGrow(ta);
    this.refreshAc(ta);
  }

  onKeydown(e: KeyboardEvent): void {
    const ac = this.autocompleteOpen() && this.filtered().length;
    if (ac) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex.update((i) => (i + 1) % this.filtered().length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const len = this.filtered().length;
        this.selectedIndex.update((i) => (i - 1 + len) % len);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.apply(this.filtered()[this.selectedIndex()]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
    }
    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      this.submit();
    }
  }

  refreshAc(ta: HTMLTextAreaElement): void {
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);
    const m = before.match(/(^|\s)([/$])([^\s]*)$/);
    if (!m) {
      this.close();
      return;
    }
    const trigger = m[2] as '/' | '$';
    const query = m[3] ?? '';
    const tokenStart = caret - (query.length + 1);
    const trailing = ta.value.slice(caret).match(/^[^\s]*/)?.[0] ?? '';
    this.range = { start: tokenStart, end: caret + trailing.length };
    this.activeTrigger.set(trigger);
    this.activeQuery.set(query);
    this.autocompleteOpen.set(true);
    this.selectedIndex.set(0);
    if (!this.filtered().length) this.close();
  }

  apply(item: ClaudeAutocompleteItem | undefined): void {
    const ta = this.ta.nativeElement;
    if (!ta || !item || !this.range) return;
    const { start, end } = this.range;
    const next = `${ta.value.slice(0, start)}${item.insertText}${ta.value.slice(end)}`;
    const caret = start + item.insertText.length;
    this.valueChange.emit(next);
    this.close();
    queueMicrotask(() => {
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      this.autoGrow(ta);
    });
  }

  submit(): void {
    const v = this.value().trim();
    if (!v || this.submitting()) return;
    this.send.emit(v);
  }

  focus(): void {
    this.ta.nativeElement?.focus();
  }

  focusAtEnd(): void {
    queueMicrotask(() => {
      const textarea = this.ta.nativeElement;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      this.autoGrow(textarea);
    });
  }

  private autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 256) + 'px';
  }

  private close(): void {
    this.range = null;
    this.autocompleteOpen.set(false);
    this.activeTrigger.set(null);
    this.activeQuery.set('');
    this.selectedIndex.set(0);
  }

  onDocumentMousedown(event: MouseEvent): void {
    if (!this.autocompleteOpen()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.close();
  }
}

function score(item: ClaudeAutocompleteItem, query: string): number {
  if (!query) return item.source === 'builtin' ? 200 : 100;
  const label = item.label.toLowerCase();
  if (label === `${item.trigger}${query}`) return 500;
  if (label.startsWith(`${item.trigger}${query}`)) return 400;
  if (label.includes(query)) return 300;
  if ((item.description || '').toLowerCase().includes(query)) return 200;
  return Number.NEGATIVE_INFINITY;
}
