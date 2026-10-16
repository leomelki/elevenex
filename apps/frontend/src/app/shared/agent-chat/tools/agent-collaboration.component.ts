import { SubagentIdentityComponent } from '@/shared/agent-chat/activity/subagent-identity.component';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideUsers,
  lucideSend,
  lucideMessageSquare,
  lucideCornerDownRight,
  lucideTimer,
  lucideListChecks,
  lucidePause,
  lucidePlay,
  lucideCircleX,
  lucideChevronRight,
  lucideArrowUpRight,
  lucideCopy,
  lucideCheck,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { AgentMarkdownComponent } from '../markdown/agent-markdown.component';
import { SubagentStatusComponent, agentStatusLabel } from '../activity/subagent-status.component';
import { collaborationView } from '@/shared/agent-tools/agent-collaboration-format';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { toast } from 'ngx-sonner';

@Component({
  selector: 'cw-agent-collaboration',
  imports: [
    SubagentIdentityComponent,
    ZardButtonComponent,
    NgIcon,
    AgentMarkdownComponent,
    SubagentStatusComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideUsers,
      lucideSend,
      lucideMessageSquare,
      lucideCornerDownRight,
      lucideTimer,
      lucideListChecks,
      lucidePause,
      lucidePlay,
      lucideCircleX,
      lucideChevronRight,
      lucideArrowUpRight,
      lucideCopy,
      lucideCheck,
      lucideLoaderCircle,
    }),
  ],
  templateUrl: './agent-collaboration.component.html',
})
export class AgentCollaborationComponent {
  readonly call = input.required<AgentTranscriptItem>();
  readonly result = input<AgentTranscriptItem | null>(null);
  readonly agents = input<ReadonlyMap<string, AgentSubagentState>>();
  readonly isLive = input(false);
  readonly canInspect = input(false);
  readonly worktreePath = input<string | null>(null);
  readonly elapsedSeconds = input(0);
  readonly inspectAgent = output<string>();
  readonly openLocalFile = output<LocalFileTarget>();
  readonly expanded = signal(false);
  readonly showAll = signal(false);
  readonly rawOpen = signal(false);
  readonly copied = signal<string | null>(null);
  readonly view = computed(() =>
    collaborationView(this.call(), this.result(), this.agents(), this.isLive()),
  );
  readonly prominentRows = computed(() =>
    (this.view()?.rows ?? []).filter((row) => {
      const snapshot = ['list', 'wait'].includes(this.view()?.action ?? '');
      if (snapshot && !row.agentId) return this.isLive() && !this.result();
      const state =
        this.agents()?.get(row.agentId ?? row.reference) ?? row.currentStatus ?? row.status;
      return (
        state?.status !== 'stopped' ||
        ['error', 'unavailable'].includes(state.executionStatus ?? '')
      );
    }),
  );
  readonly compact = computed(
    () => !!this.result() && !this.view()?.error && !this.prominentRows().length,
  );
  readonly compactOutcome = computed(() => {
    const view = this.view();
    const row = view?.rows[0];
    const status = row?.currentStatus ?? row?.status;
    return view?.action === 'spawn' && status ? agentStatusLabel(status) : view?.outcome;
  });
  readonly displayedOutcome = computed(() => {
    const view = this.view();
    if (view?.action === 'list' && this.result() && !view.error) {
      if (this.expanded()) return `At this step: ${view.outcome}`;
      if (!view.rows.length) return 'No agents';
      const states = view.rows.flatMap((row) => {
        const agent = this.agents()?.get(row.agentId ?? row.reference);
        return agent ? [agent] : [];
      });
      const active = states.filter((state) => state.status === 'started').length;
      const finished = states.filter((state) => state.status === 'stopped').length;
      return `${view.rows.length} agent${view.rows.length === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}${finished ? ` · ${finished} finished` : ''}`;
    }
    return this.compact() ? this.compactOutcome() : view?.outcome;
  });
  readonly visibleRows = computed(() => {
    const rows = this.view()?.rows ?? [];
    if (!this.expanded()) return this.prominentRows().slice(0, 3);
    return this.showAll()
      ? rows
      : rows.slice(0, this.view()?.action === 'list' || this.view()?.action === 'wait' ? 6 : 3);
  });
  readonly rawData = computed(() =>
    this.rawOpen()
      ? JSON.stringify(
          {
            input: this.call().providerToolInput ?? this.call().toolInput,
            result: this.result()?.content,
          },
          null,
          2,
        )
      : '',
  );
  readonly payloadPreview = computed(() =>
    this.view()?.payload?.replace(/\s+/g, ' ').slice(0, 140),
  );
  readonly toneClass = computed(
    () =>
      ({
        success: 'text-success',
        warning: 'text-warning',
        destructive: 'text-destructive',
        muted: 'text-muted-foreground',
      })[this.compact() ? 'muted' : (this.view()?.tone ?? 'muted')],
  );

  async copy(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(key);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy to clipboard.');
    }
  }
}
