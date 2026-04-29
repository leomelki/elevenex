import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, input, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBrain, lucideChevronRight } from '@ng-icons/lucide';
import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { MarkdownPipe } from '../pipes/markdown.pipe';

@Component({
  selector: 'cw-thinking',
  standalone: true,
  imports: [CommonModule, NgIcon, MarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBrain, lucideChevronRight })],
  template: `
    @if (content().trim()) {
      <div class="cw-think">
        <button type="button" class="cw-think__head" (click)="toggle()">
          <ng-icon name="lucideBrain" size="13" />
          <span>{{ streaming() ? 'Thinking…' : 'Reasoning' }}</span>
          <span class="cw-think__preview">— {{ preview() }}</span>
          <ng-icon name="lucideChevronRight" size="13" class="cw-think__chev" [class.rotate-90]="open()" />
        </button>
        @if (open()) {
          <div class="cw-think__body" #bodyEl (scroll)="onBodyScroll($event)">
            @if (streaming()) {
              <div class="cw-think__streaming">{{ content() }}</div>
            } @else {
              <div class="cw-think__md" [innerHTML]="content() | cwMarkdown"></div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-think {
        color: var(--muted-foreground);
        font-size: 0.75rem;
      }
      .cw-think__head {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        max-width: 100%;
        border: 0;
        background: transparent;
        cursor: pointer;
        color: inherit;
        font: inherit;
        padding: 0.125rem 0.25rem;
        margin-left: -0.25rem;
        border-radius: 0.25rem;
      }
      .cw-think__head:hover {
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
      }
      .cw-think__preview {
        max-width: 24rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: 0.8;
      }
      .cw-think__chev {
        transition: transform 120ms ease;
      }
      .cw-think__chev.rotate-90 {
        transform: rotate(90deg);
      }
      .cw-think__body {
        margin: 0.375rem 0 0;
        padding: 0.5rem 0.75rem;
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
        border-left: 2px solid var(--border);
        border-radius: 0 0.25rem 0.25rem 0;
        font-size: 0.8125rem;
        line-height: 1.6;
        max-height: 24rem;
        overflow: auto;
      }
      .cw-think__streaming {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-think__md :first-child {
        margin-top: 0;
      }
      .cw-think__md :last-child {
        margin-bottom: 0;
      }
      .cw-think__md p {
        margin: 0.375rem 0;
      }
      .cw-think__md ul,
      .cw-think__md ol {
        margin: 0.375rem 0;
        padding-left: 1.25rem;
      }
      .cw-think__md code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        padding: 0.0625rem 0.25rem;
        border-radius: 0.25rem;
        font-size: 0.8125em;
      }
      .cw-think__md pre {
        margin: 0.375rem 0;
        padding: 0.5rem 0.625rem;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        border-radius: 0.375rem;
        font-size: 0.75rem;
        overflow: auto;
      }
    `,
  ],
})
export class ClaudeThinkingComponent {
  readonly item = input.required<ClaudeTranscriptItem>();
  readonly streaming = input<boolean>(false);
  readonly openState = signal<boolean | null>(null);

  @ViewChild('bodyEl') private bodyEl?: ElementRef<HTMLElement>;
  private _userScrolled = false;

  readonly content = computed(() => this.item().content ?? '');

  readonly open = computed(() => {
    const explicit = this.openState();
    if (explicit !== null) return explicit;
    return this.streaming();
  });

  readonly preview = computed(() => {
    const text = this.content().trim();
    if (!text) return '';
    const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
    const clean = firstLine.replace(/[*_`#>]+/g, '').trim();
    return clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
  });

  constructor() {
    effect(() => {
      const isStreaming = this.streaming();
      void this.content(); // track content changes
      if (!isStreaming) {
        this._userScrolled = false;
        return;
      }
      if (!this._userScrolled) {
        setTimeout(() => {
          const el = this.bodyEl?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        }, 0);
      }
    });
  }

  onBodyScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement;
    this._userScrolled = el.scrollHeight - el.scrollTop - el.clientHeight > 32;
  }

  toggle(): void {
    this.openState.set(!this.open());
  }
}
