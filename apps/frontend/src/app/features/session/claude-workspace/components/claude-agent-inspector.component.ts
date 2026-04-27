import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideActivity,
  lucideFileSearch,
  lucideScrollText,
  lucideX,
} from '@ng-icons/lucide';
import {
  ClaudeHookEvent,
  ClaudeSubagentHistoryPayload,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { ClaudeToolCallComponent } from './claude-tool-call.component';
import { ClaudeMessageComponent } from './claude-message.component';
import {
  AgentTimelineEntry,
  TurnAgentRun,
  TurnAgentSummary,
  buildAgentTimelineEntries,
  buildAgentTranscriptUnits,
  formatTimestamp,
  humanizeAgentType,
} from '../util/agent-deep-dive';

export interface ClaudeSubagentHistoryState {
  loading: boolean;
  data: ClaudeSubagentHistoryPayload | null;
  error: string | null;
}

@Component({
  selector: 'cw-agent-inspector',
  standalone: true,
  imports: [CommonModule, NgIcon, ClaudeToolCallComponent, ClaudeMessageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideActivity,
      lucideFileSearch,
      lucideScrollText,
      lucideX,
    }),
  ],
  template: `
    @if (open()) {
      @if (turn(); as currentTurn) {
        <div class="cw-agent-dive__backdrop" (click)="close.emit()"></div>
        <aside class="cw-agent-dive">
          <header class="cw-agent-dive__head">
            <div>
              <div class="cw-agent-dive__eyebrow">Agent Deep Dive</div>
              <h3>Worked for {{ currentTurn.durationLabel }} · {{ currentTurn.stepCount }} steps · {{ currentTurn.agents.length }} agent{{ currentTurn.agents.length === 1 ? '' : 's' }}</h3>
            </div>
            <button type="button" class="cw-agent-dive__close" (click)="close.emit()">
              <ng-icon name="lucideX" size="15" />
            </button>
          </header>

          <div class="cw-agent-dive__body">
            <nav class="cw-agent-dive__rail" aria-label="Agents">
              @for (agent of currentTurn.agents; track agent.agentId) {
                <button
                  type="button"
                  class="cw-agent-dive__agent"
                  [class.cw-agent-dive__agent--active]="agent.agentId === selectedAgentId()"
                  (click)="selectAgent.emit(agent.agentId)"
                >
                  <div class="cw-agent-dive__agent-top">
                    <span class="cw-agent-dive__agent-name">{{ humanizeAgentType(agent.agentType) }}</span>
                    <span class="cw-agent-dive__agent-state" [attr.data-state]="agent.status">
                      {{ agent.status }}
                    </span>
                  </div>
                  @if (agent.summary) {
                    <div class="cw-agent-dive__agent-summary">{{ agent.summary }}</div>
                  } @else {
                    <div class="cw-agent-dive__agent-summary cw-agent-dive__agent-summary--muted">
                      No assistant summary yet
                    </div>
                  }
                  <div class="cw-agent-dive__agent-time">
                    {{ formatTimestamp(agent.startedAt || agent.lastEventAt) }}
                  </div>
                </button>
              }
            </nav>

            <section class="cw-agent-dive__main">
              @if (selectedAgent(); as agent) {
                <div class="cw-agent-dive__hero">
                  <div class="cw-agent-dive__hero-copy">
                    <div class="cw-agent-dive__hero-title">{{ humanizeAgentType(agent.agentType) }}</div>
                    <div class="cw-agent-dive__hero-meta">
                      <span>{{ agent.status === 'stopped' ? 'Completed' : 'Running' }}</span>
                      <span>{{ formatTimestamp(agent.lastEventAt) }}</span>
                      @if (agent.stopHookActive) {
                        <span>Stop hook active</span>
                      }
                    </div>
                  </div>
                  <div class="cw-agent-dive__tabs">
                    <button type="button" [class.is-active]="tab() === 'timeline'" (click)="tab.set('timeline')">
                      <ng-icon name="lucideActivity" size="13" />
                      Timeline
                    </button>
                    <button type="button" [class.is-active]="tab() === 'transcript'" (click)="tab.set('transcript')">
                      <ng-icon name="lucideScrollText" size="13" />
                      Transcript
                    </button>
                    <button type="button" [class.is-active]="tab() === 'hooks'" (click)="tab.set('hooks')">
                      <ng-icon name="lucideFileSearch" size="13" />
                      Hooks
                    </button>
                  </div>
                </div>

                @if (selectedHistoryState()?.loading) {
                  <div class="cw-agent-dive__empty">Loading agent transcript…</div>
                } @else if (tab() === 'timeline') {
                  <div class="cw-agent-dive__timeline">
                    @for (entry of timelineEntries(); track entry.id) {
                      @switch (entry.kind) {
                        @case ('event') {
                          <article class="cw-agent-dive__event" [attr.data-tone]="entry.tone">
                            <div class="cw-agent-dive__event-label">{{ entry.label }}</div>
                            <div class="cw-agent-dive__event-detail">{{ entry.detail }}</div>
                          </article>
                        }
                        @case ('message') {
                          <article class="cw-agent-dive__note" [attr.data-tone]="entry.tone">
                            <div class="cw-agent-dive__note-label">{{ entry.label }}</div>
                            <div class="cw-agent-dive__note-copy">{{ entry.content }}</div>
                          </article>
                        }
                        @case ('tool') {
                          <cw-tool-call [call]="entry.call" [result]="entry.result" />
                        }
                        @case ('cluster') {
                          <details class="cw-agent-dive__cluster">
                            <summary>{{ entry.label }}</summary>
                            <div class="cw-agent-dive__cluster-items">
                              @for (item of entry.items; track item.id) {
                                <article class="cw-agent-dive__cluster-item">
                                  <div class="cw-agent-dive__cluster-kind">{{ clusterItemLabel(item) }}</div>
                                  <div class="cw-agent-dive__cluster-copy">{{ item.content }}</div>
                                </article>
                              }
                            </div>
                          </details>
                        }
                      }
                    }

                    @if (!timelineEntries().length) {
                      <div class="cw-agent-dive__empty">No timeline details yet.</div>
                    }
                  </div>
                } @else if (tab() === 'transcript') {
                  @if (selectedHistoryState()?.data?.transcriptAvailable === false) {
                    <div class="cw-agent-dive__empty">
                      {{ selectedHistoryState()?.data?.transcriptError || selectedHistoryState()?.error || 'Transcript unavailable.' }}
                    </div>
                  } @else {
                    <div class="cw-agent-dive__timeline">
                      @for (unit of transcriptUnits(); track unit.id) {
                        @switch (unit.kind) {
                          @case ('message') {
                            <cw-message [item]="unit.item" />
                          }
                          @case ('thinking') {
                            <article class="cw-agent-dive__note">
                              <div class="cw-agent-dive__note-label">Thinking</div>
                              <div class="cw-agent-dive__note-copy">{{ unit.item.content }}</div>
                            </article>
                          }
                          @case ('tool') {
                            <cw-tool-call [call]="unit.call" [result]="unit.result" />
                          }
                          @case ('system') {
                            <article class="cw-agent-dive__note">
                              <div class="cw-agent-dive__note-label">System</div>
                              <div class="cw-agent-dive__note-copy">{{ unit.item.content }}</div>
                            </article>
                          }
                        }
                      }
                      @if (!transcriptUnits().length) {
                        <div class="cw-agent-dive__empty">No transcript events available.</div>
                      }
                    </div>
                  }
                } @else {
                  <div class="cw-agent-dive__timeline">
                    @for (event of hookEventsForSelectedAgent(); track event.eventName + ':' + event.timestamp) {
                      <article class="cw-agent-dive__event">
                        <div class="cw-agent-dive__event-label">{{ event.eventName }}</div>
                        <div class="cw-agent-dive__event-detail">{{ formatTimestamp(event.timestamp) }}</div>
                      </article>
                    }
                    @if (!hookEventsForSelectedAgent().length) {
                      <div class="cw-agent-dive__empty">No hook events captured for this agent.</div>
                    }
                  </div>
                }
              }
            </section>
          </div>
        </aside>
      }
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .cw-agent-dive__backdrop {
        position: fixed;
        inset: 0;
        z-index: 44;
        background:
          radial-gradient(circle at top right, color-mix(in oklab, var(--primary) 10%, transparent), transparent 28%),
          color-mix(in oklab, #09111f 45%, transparent);
        backdrop-filter: blur(4px);
      }
      .cw-agent-dive {
        position: fixed;
        inset: 0 0 0 auto;
        z-index: 45;
        width: min(78rem, 100vw);
        background:
          linear-gradient(180deg, color-mix(in oklab, var(--background) 98%, white 2%), var(--background));
        border-left: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
        display: flex;
        flex-direction: column;
        box-shadow: -24px 0 64px -30px color-mix(in oklab, #000 55%, transparent);
      }
      .cw-agent-dive__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1rem 0.9rem;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 72%, transparent);
      }
      .cw-agent-dive__eyebrow {
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-agent-dive__head h3 {
        margin: 0.2rem 0 0;
        font-size: 1rem;
        line-height: 1.35;
      }
      .cw-agent-dive__close {
        width: 2rem;
        height: 2rem;
        border: 0;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        color: var(--muted-foreground);
        cursor: pointer;
      }
      .cw-agent-dive__body {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(16rem, 19rem) minmax(0, 1fr);
      }
      .cw-agent-dive__rail {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding: 1rem;
        overflow: auto;
        border-right: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
        background:
          linear-gradient(180deg, color-mix(in oklab, var(--card) 88%, white 4%), color-mix(in oklab, var(--background) 94%, var(--card)));
      }
      .cw-agent-dive__agent {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.45rem;
        width: 100%;
        padding: 0.8rem 0.875rem;
        border-radius: 1rem;
        border: 1px solid color-mix(in oklab, var(--border) 90%, transparent);
        background: color-mix(in oklab, var(--background) 88%, var(--card));
        text-align: left;
        cursor: pointer;
      }
      .cw-agent-dive__agent--active {
        border-color: color-mix(in oklab, var(--primary) 36%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--card));
        box-shadow: 0 14px 28px -22px color-mix(in oklab, var(--primary) 60%, transparent);
      }
      .cw-agent-dive__agent-top {
        width: 100%;
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .cw-agent-dive__agent-name {
        font-weight: 600;
        color: var(--foreground);
      }
      .cw-agent-dive__agent-state {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted-foreground);
      }
      .cw-agent-dive__agent-state[data-state='stopped'] {
        color: color-mix(in oklab, #0f9f6e 82%, var(--foreground));
      }
      .cw-agent-dive__agent-summary {
        font-size: 0.8125rem;
        line-height: 1.45;
        color: var(--foreground);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .cw-agent-dive__agent-summary--muted,
      .cw-agent-dive__agent-time {
        color: var(--muted-foreground);
      }
      .cw-agent-dive__agent-time {
        font-size: 0.75rem;
      }
      .cw-agent-dive__main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .cw-agent-dive__hero {
        padding: 1rem 1.1rem 0.9rem;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 72%, transparent);
        background:
          radial-gradient(circle at top right, color-mix(in oklab, var(--primary) 10%, transparent), transparent 32%),
          linear-gradient(180deg, color-mix(in oklab, var(--card) 95%, white 5%), color-mix(in oklab, var(--background) 96%, var(--card)));
      }
      .cw-agent-dive__hero-title {
        font-size: 1rem;
        font-weight: 700;
      }
      .cw-agent-dive__hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.35rem;
        font-size: 0.75rem;
        color: var(--muted-foreground);
      }
      .cw-agent-dive__tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.9rem;
      }
      .cw-agent-dive__tabs button {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.42rem 0.75rem;
        border-radius: 999px;
        border: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
        background: color-mix(in oklab, var(--background) 92%, var(--card));
        color: var(--muted-foreground);
        cursor: pointer;
      }
      .cw-agent-dive__tabs button.is-active {
        border-color: color-mix(in oklab, var(--primary) 38%, var(--border));
        background: color-mix(in oklab, var(--primary) 9%, var(--card));
        color: var(--foreground);
      }
      .cw-agent-dive__timeline {
        flex: 1;
        overflow: auto;
        padding: 1rem 1.1rem 1.4rem;
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
      }
      .cw-agent-dive__event,
      .cw-agent-dive__note,
      .cw-agent-dive__cluster {
        border: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
        border-radius: 1rem;
        background: color-mix(in oklab, var(--card) 94%, transparent);
        padding: 0.8rem 0.9rem;
      }
      .cw-agent-dive__event[data-tone='success'] {
        border-color: color-mix(in oklab, #0f9f6e 28%, var(--border));
      }
      .cw-agent-dive__event[data-tone='warning'] {
        border-color: color-mix(in oklab, #f59e0b 32%, var(--border));
      }
      .cw-agent-dive__note[data-tone='accent'] {
        border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--card));
      }
      .cw-agent-dive__event-label,
      .cw-agent-dive__note-label,
      .cw-agent-dive__cluster summary {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted-foreground);
      }
      .cw-agent-dive__event-detail,
      .cw-agent-dive__note-copy,
      .cw-agent-dive__cluster-copy {
        margin-top: 0.35rem;
        font-size: 0.875rem;
        line-height: 1.55;
        white-space: pre-wrap;
        color: var(--foreground);
      }
      .cw-agent-dive__cluster summary {
        cursor: pointer;
      }
      .cw-agent-dive__cluster-items {
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        margin-top: 0.85rem;
      }
      .cw-agent-dive__cluster-item + .cw-agent-dive__cluster-item {
        padding-top: 0.65rem;
        border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
      }
      .cw-agent-dive__cluster-kind {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted-foreground);
      }
      .cw-agent-dive__empty {
        margin: 1rem 1.1rem;
        padding: 1rem;
        border-radius: 1rem;
        border: 1px dashed color-mix(in oklab, var(--border) 86%, transparent);
        color: var(--muted-foreground);
        font-size: 0.875rem;
      }
      @media (max-width: 900px) {
        .cw-agent-dive {
          width: 100vw;
        }
        .cw-agent-dive__body {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr);
        }
        .cw-agent-dive__rail {
          flex-direction: row;
          padding-bottom: 0.75rem;
          border-right: 0;
          border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
        }
        .cw-agent-dive__agent {
          min-width: 16rem;
        }
      }
    `,
  ],
})
export class ClaudeAgentInspectorComponent {
  readonly open = input<boolean>(false);
  readonly turn = input<TurnAgentSummary | null>(null);
  readonly selectedAgentId = input<string | null>(null);
  readonly historyByAgent = input<Record<string, ClaudeSubagentHistoryState>>({});
  readonly hookEvents = input<ClaudeHookEvent[]>([]);

  readonly close = output<void>();
  readonly selectAgent = output<string>();

  readonly tab = signal<'timeline' | 'transcript' | 'hooks'>('timeline');

  readonly selectedAgent = computed<TurnAgentRun | null>(() => {
    const turn = this.turn();
    const selectedId = this.selectedAgentId();
    if (!turn || !selectedId) return null;
    return turn.agents.find((agent) => agent.agentId === selectedId) ?? null;
  });

  readonly selectedHistoryState = computed<ClaudeSubagentHistoryState | null>(() => {
    const selectedId = this.selectedAgentId();
    return selectedId ? this.historyByAgent()[selectedId] ?? null : null;
  });

  readonly timelineEntries = computed<AgentTimelineEntry[]>(() =>
    buildAgentTimelineEntries(
      this.selectedHistoryState()?.data ?? null,
      this.selectedAgent(),
    ),
  );

  readonly transcriptUnits = computed(() =>
    buildAgentTranscriptUnits(this.selectedHistoryState()?.data ?? null),
  );

  readonly hookEventsForSelectedAgent = computed(() => {
    const agent = this.selectedAgent();
    const turn = this.turn();
    if (!agent || !turn) return [];
    return this.hookEvents().filter(
      (event) =>
        event.agentId === agent.agentId
        && new Date(event.timestamp).getTime() >= new Date(turn.startedAt).getTime()
        && new Date(event.timestamp).getTime() <= new Date(turn.completedAt).getTime(),
    );
  });

  protected readonly humanizeAgentType = humanizeAgentType;
  protected readonly formatTimestamp = formatTimestamp;

  clusterItemLabel(item: ClaudeTranscriptItem): string {
    if (item.kind === 'thinking') return 'Thinking';
    if (item.kind === 'system') return 'System';
    return 'Note';
  }
}
