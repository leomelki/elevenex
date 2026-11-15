import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideCopy,
  lucideLoaderCircle,
  lucideShield,
  lucideTerminal,
  lucideWrapText,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import {
  formatShellDuration,
  shellOutputWindow,
  shellToolView,
} from '@/shared/agent-tools/shell-tool-format';

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
      lucideTerminal,
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
  // Key local drafts to the tool identity: recycled transcript views must not inherit them.
  private readonly disclosure = signal<{ id: string; open: boolean } | null>(null);
  private readonly expandedOutput = signal<string | null>(null);
  readonly wrap = signal(true);
  readonly commandSummary = computed(() =>
    this.view().command.slice(0, 300).replace(/\s+/g, ' ').trim(),
  );
  readonly commandPreview = computed(() => this.view().command.slice(0, 24_000));
  private readonly copyState = signal<{
    id: string;
    target: 'command' | 'output';
    status: 'copying' | 'copied' | 'failed';
  } | null>(null);
  readonly open = computed(() =>
    this.disclosure()?.id === this.call().id
      ? this.disclosure()!.open
      : this.view().state === 'error',
  );
  readonly moreOutput = computed(() => this.expandedOutput() === this.call().id);
  readonly outputWindow = computed(() => shellOutputWindow(this.view().output, this.moreOutput()));
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
      return `${state.target === 'command' ? 'Command' : 'Output'} copied.`;
    return '';
  });

  toggle(): void {
    this.disclosure.set({ id: this.call().id, open: !this.open() });
  }
  toggleOutput(): void {
    this.expandedOutput.set(this.moreOutput() ? null : this.call().id);
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
      if (!this.destroyRef.destroyed && this.call().id === state.id && this.copyState() === state)
        this.copyState.set({ ...state, status: 'copied' });
    } catch {
      if (!this.destroyRef.destroyed && this.call().id === state.id && this.copyState() === state)
        this.copyState.set({ ...state, status: 'failed' });
    }
  }
}
