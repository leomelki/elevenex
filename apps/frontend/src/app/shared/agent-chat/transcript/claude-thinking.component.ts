import { ZardButtonComponent } from '@/shared/components/button';
import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  signal,
  ViewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBrain, lucideChevronRight } from '@ng-icons/lucide';

@Component({
  selector: 'cw-thinking',
  standalone: true,
  imports: [ZardButtonComponent, CommonModule, NgIcon, AgentMarkdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  viewProviders: [provideIcons({ lucideBrain, lucideChevronRight })],
  templateUrl: './claude-thinking.component.html',
})
export class ClaudeThinkingComponent {
  readonly item = input.required<AgentTranscriptItem>();
  readonly streaming = input<boolean>(false);
  readonly openState = signal<boolean | null>(null);

  @ViewChild('bodyEl') private bodyEl?: ElementRef<HTMLElement>;
  private _userScrolled = false;

  readonly content = computed(() => this.item().content ?? '');
  readonly hasBody = computed(() => this.content().trim().length > 0);

  readonly open = computed(() => {
    const explicit = this.openState();
    if (explicit !== null) return explicit;
    return this.streaming();
  });

  // Anthropic occasionally redacts the model's thinking content — the block
  // arrives with an empty `thinking` string and only a signature, and no
  // `thinking_delta` events follow. We still render an indicator so the user
  // knows the model reasoned about this turn even when the text is encrypted.
  readonly headerLabel = computed(() => {
    if (this.streaming()) return 'Thinking…';
    if (this.hasBody()) return 'Reasoning';
    return 'Reasoning (encrypted)';
  });

  readonly preview = computed(() => {
    const text = this.content().trim();
    if (!text) return '';
    const lines = text.split('\n');
    const lastLine = [...lines].reverse().find((l) => l.trim()) ?? '';
    const clean = lastLine.replace(/[*_`#>]+/g, '').trim();
    const hasMore = lines.find((l) => l.trim()) !== lastLine;
    const truncated = clean.length > 80 ? clean.slice(-80) : clean;
    return hasMore || clean.length > 80 ? '… ' + truncated : truncated;
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
