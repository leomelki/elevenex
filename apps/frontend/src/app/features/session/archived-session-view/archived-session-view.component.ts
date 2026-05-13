import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, SimpleChanges, inject, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideArchiveRestore } from '@ng-icons/lucide';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentProviderId, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

export interface ArchivedSessionSummary {
  id: number;
  name: string | null;
  branchName: string;
  activeAgentProvider: AgentProviderId;
}

interface ArchivedTranscriptItem {
  id: string;
  role: string;
  content: string;
  timestamp: string | null;
}

@Component({
  selector: 'app-archived-session-view',
  standalone: true,
  imports: [CommonModule, NgIcon],
  viewProviders: [
    provideIcons({
      lucideArchive,
      lucideArchiveRestore,
    }),
  ],
  template: `
    <section class="flex h-full min-h-0 flex-col bg-background">
      <header class="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            <ng-icon name="lucideArchive" size="17" />
          </span>
          <div class="min-w-0">
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="truncate text-sm font-semibold text-foreground">{{ session.name ?? 'Session ' + session.id }}</h2>
              <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">Archived</span>
            </div>
            <p class="truncate text-xs text-muted-foreground">{{ session.branchName }}</p>
          </div>
        </div>
        <button
          type="button"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          [disabled]="unarchiveBusy"
          (click)="unarchive.emit(session.id)"
        >
          <ng-icon name="lucideArchiveRestore" size="14" />
          {{ unarchiveBusy ? 'Restoring' : 'Unarchive' }}
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        @if (loading()) {
          <div class="mx-auto max-w-3xl space-y-3">
            <div class="h-16 rounded-md bg-muted animate-pulse"></div>
            <div class="h-24 rounded-md bg-muted animate-pulse"></div>
            <div class="h-14 rounded-md bg-muted animate-pulse"></div>
          </div>
        } @else if (error()) {
          <div class="mx-auto max-w-2xl rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {{ error() }}
          </div>
        } @else if (items().length === 0) {
          <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
            No transcript is available for this archived session.
          </div>
        } @else {
          <div class="mx-auto flex max-w-4xl flex-col gap-4">
            @for (item of items(); track item.id) {
              <article
                class="rounded-md border border-border bg-card p-3"
                [class.ml-auto]="item.role === 'user'"
                [class.max-w-[78ch]]="item.role === 'user'"
              >
                <div class="mb-2 flex items-center justify-between gap-3">
                  <span class="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">{{ item.role }}</span>
                  @if (item.timestamp) {
                    <span class="text-[0.68rem] text-muted-foreground">{{ formatTimestamp(item.timestamp) }}</span>
                  }
                </div>
                <pre class="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">{{ item.content }}</pre>
              </article>
            }
          </div>
        }
      </div>
    </section>
  `,
})
export class ArchivedSessionViewComponent implements OnChanges {
  @Input({ required: true }) session!: ArchivedSessionSummary;
  @Input() unarchiveBusy = false;

  readonly unarchive = output<number>();

  private readonly agentApi = inject(AgentRuntimeApiService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly items = signal<ArchivedTranscriptItem[]>([]);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['session']) {
      this.loadHistory();
    }
  }

  formatTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  private loadHistory(): void {
    if (!this.session) {
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.agentApi.getHistory(this.session.id, this.session.activeAgentProvider).subscribe({
      next: (history) => {
        this.items.set(history.map((item, index) => this.normalizeItem(item, index)));
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.message || 'Could not load archived transcript.');
        this.loading.set(false);
      },
    });
  }

  private normalizeItem(item: AgentTranscriptItem, index: number): ArchivedTranscriptItem {
    if (!item || typeof item !== 'object') {
      return {
        id: `item-${index}`,
        role: 'entry',
        content: String(item ?? ''),
        timestamp: null,
      };
    }

    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : `item-${index}`;
    const role = typeof record['kind'] === 'string'
      ? record['kind']
      : typeof record['role'] === 'string'
        ? record['role']
        : 'entry';
    const content = typeof record['content'] === 'string'
      ? record['content']
      : JSON.stringify(record['content'] ?? record, null, 2);
    const timestamp = typeof record['receivedAt'] === 'string'
      ? record['receivedAt']
      : typeof record['authoredAt'] === 'string'
        ? record['authoredAt']
        : typeof record['timestamp'] === 'string'
          ? record['timestamp']
          : null;

    return { id, role, content, timestamp };
  }
}
