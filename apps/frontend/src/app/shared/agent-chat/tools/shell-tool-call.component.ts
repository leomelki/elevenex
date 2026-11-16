import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideCopy,
  lucideLoaderCircle,
  lucideShield,
  lucideWrapText,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import {
  formatShellDuration,
  shellToolView,
  terminalWindow,
} from '@/shared/agent-tools/shell-tool-format';

/** Distance from the bottom (px) still treated as "following" the end of the output. */
const STICK_THRESHOLD = 24;

@Component({
  selector: 'cw-shell-tool-call',
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronRight,
      lucideCircleAlert,
      lucideCopy,
      lucideLoaderCircle,
      lucideShield,
      lucideWrapText,
    }),
  ],
  templateUrl: './shell-tool-call.component.html',
  styleUrl: './shell-tool-call.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellToolCallComponent {
  readonly call = input.required<AgentTranscriptItem>();
  readonly result = input<AgentTranscriptItem | null>(null);
  readonly isLive = input(false);
  readonly elapsedSeconds = input(0);
  readonly view = computed(() => shellToolView(this.call(), this.result(), this.isLive()));
  private readonly destroyRef = inject(DestroyRef);
  private readonly screen = viewChild<ElementRef<HTMLElement>>('screen');
  // Key local drafts to the tool identity: recycled transcript views must not inherit them.
  private readonly collapsedId = signal<string | null>(null);
  private readonly showAllId = signal<string | null>(null);
  readonly wrap = signal(true);
  readonly commandSummary = computed(() =>
    this.view().command.slice(0, 300).replace(/\s+/g, ' ').trim(),
  );
  readonly commandPreview = computed(() => this.view().command.slice(0, 24_000));
  readonly directoryLabel = computed(() => {
    const parts = this.view()
      .directory.replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : this.view().directory;
  });
  private readonly copyState = signal<{
    id: string;
    target: 'command' | 'output';
    status: 'copying' | 'copied' | 'failed';
  } | null>(null);
  readonly open = computed(() => this.collapsedId() !== this.call().id);
  readonly showAll = computed(() => this.showAllId() === this.call().id);
  readonly terminal = computed(() => terminalWindow(this.view().lines, this.showAll()));
  readonly status = computed(() =>
    this.view().state === 'running'
      ? `Running ${formatShellDuration(this.elapsedSeconds())}`
      : this.view().status,
  );
  readonly stateIcon = computed(() => {
    switch (this.view().state) {
      case 'running':
        return 'lucideLoaderCircle';
      case 'denied':
        return 'lucideShield';
      case 'error':
      case 'interrupted':
      case 'incomplete':
        return 'lucideCircleAlert';
      default:
        return 'lucideCheck';
    }
  });
  readonly copyFeedback = computed(() => {
    const state = this.copyState();
    if (state?.id !== this.call().id) return '';
    if (state.status === 'failed') return 'Could not copy. Select the text to copy it.';
    if (state.status === 'copied')
      return `${state.target === 'command' ? 'Command' : 'Output'} copied`;
    return '';
  });

  // Terminal scroll anchoring: start at the end, keep following new output while the reader is
  // at the bottom, and keep their place when earlier lines are inserted above.
  private follow = true;
  private anchor: { id: string; fromBottom: number } | null = null;
  private renderedId: string | null = null;

  constructor() {
    afterRenderEffect(() => {
      this.terminal();
      this.wrap();
      const element = this.screen()?.nativeElement;
      if (!element) return;
      const id = this.call().id;
      if (this.renderedId !== id) {
        this.renderedId = id;
        this.follow = true;
        this.anchor = null;
      }
      if (this.anchor?.id === id) {
        element.scrollTop = element.scrollHeight - element.clientHeight - this.anchor.fromBottom;
        this.anchor = null;
      } else if (this.follow) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  onScroll(element: HTMLElement): void {
    this.follow =
      element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD;
  }

  toggle(): void {
    this.collapsedId.set(this.open() ? this.call().id : null);
  }

  toggleShowAll(): void {
    const element = this.screen()?.nativeElement;
    if (element)
      this.anchor = {
        id: this.call().id,
        fromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
      };
    this.showAllId.set(this.showAll() ? null : this.call().id);
  }

  copying(target: 'command' | 'output'): boolean {
    const state = this.copyState();
    return state?.id === this.call().id && state.target === target && state.status === 'copying';
  }

  async copy(target: 'command' | 'output'): Promise<void> {
    const state = { id: this.call().id, target, status: 'copying' as const };
    this.copyState.set(state);
    try {
      await navigator.clipboard.writeText(this.view()[target]);
      if (!this.destroyRef.destroyed && this.call().id === state.id && this.copyState() === state) {
        const copied = { ...state, status: 'copied' as const };
        this.copyState.set(copied);
        const timer = setTimeout(() => {
          if (this.copyState() === copied) this.copyState.set(null);
        }, 1600);
        this.destroyRef.onDestroy(() => clearTimeout(timer));
      }
    } catch {
      if (!this.destroyRef.destroyed && this.call().id === state.id && this.copyState() === state)
        this.copyState.set({ ...state, status: 'failed' });
    }
  }
}
