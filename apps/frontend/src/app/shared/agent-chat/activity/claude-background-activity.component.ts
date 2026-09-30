import { AgentBackgroundWorkItem } from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
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
import { lucideBot, lucideChevronDown, lucideLayers } from '@ng-icons/lucide';

/**
 * Surfaces work that is still running in the background after the visible turn
 * has ended — backgrounded agents and tasks. These have no other representation
 * in the transcript (the turn that launched them is already closed), so without
 * this panel the session just looks idle while work is still happening.
 *
 * Collapsed by default to a single summary row; expands to per-item detail.
 */
@Component({
  selector: 'cw-background-activity',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBot, lucideChevronDown, lucideLayers })],
  templateUrl: './claude-background-activity.component.html',
  styleUrl: './claude-background-activity.component.scss',
})
export class ClaudeBackgroundActivityComponent {
  readonly items = input.required<AgentBackgroundWorkItem[]>();

  readonly expanded = signal(false);

  /** Ticks once a second purely so the elapsed labels stay live. */
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  readonly summaryLabel = computed(() => {
    const items = this.items();
    if (items.length === 1) {
      return `${items[0].label} running in background`;
    }
    const agents = items.filter((item) => item.kind === 'subagent').length;
    const noun = agents === items.length ? 'agents' : 'jobs';
    return `${items.length} background ${noun} running`;
  });

  /** Elapsed time of the longest-running item — the one worth watching. */
  readonly elapsedLabel = computed(() => {
    const oldest = this.items().reduce<number | null>((acc, item) => {
      const started = Date.parse(item.startedAt);
      if (Number.isNaN(started)) return acc;
      return acc === null || started < acc ? started : acc;
    }, null);
    return oldest === null ? '' : this.formatElapsed(this.now() - oldest);
  });

  elapsedFor(item: AgentBackgroundWorkItem): string {
    const started = Date.parse(item.startedAt);
    if (Number.isNaN(started)) return '';
    return this.formatElapsed(this.now() - started);
  }

  private formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
}
