import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TurnAgentSummary } from '../util/agent-deep-dive';
import type { TurnChangeDetails } from '../util/turn-change-stats';

/**
 * The band that stands in for a settled turn's work: the "Worked for X" pill,
 * the diff-stat toggle, and the agents that ran.
 *
 * Owns this markup for every surface that renders a transcript (the session
 * workspace and the embedded review/fork chats) so the two cannot drift.
 */
@Component({
  selector: 'cw-turn-summary',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[0.65rem]">
      <button
        type="button"
        class="group flex items-center gap-3.5 w-full p-0 border-0 bg-transparent text-muted-foreground cursor-pointer focus-visible:outline-none"
        [attr.aria-expanded]="expanded()"
        (click)="toggle.emit()"
      >
        <span class="flex-1 min-w-6 h-px cw-turn-line"></span>
        <span
          class="inline-flex items-center flex-wrap justify-center gap-2.5 min-w-0 px-3.5 py-[0.475rem] border border-border/92 rounded-full cw-pill-bg cw-pill-shadow transition-[border-color,background,color,box-shadow] duration-[140ms] group-hover:border-primary/35 group-hover:bg-primary/7 group-hover:bg-none group-hover:text-foreground group-focus-visible:border-primary/35 group-focus-visible:bg-primary/7 group-focus-visible:bg-none group-focus-visible:text-foreground"
        >
          <span
            [attr.data-open]="expanded() || null"
            class="w-[0.475rem] h-[0.475rem] shrink-0 border-r-[1.5px] border-b-[1.5px] border-current -rotate-45 data-[open]:rotate-45 transition-transform duration-[140ms] ease-in-out opacity-75"
          ></span>
          <span class="text-[0.8125rem] font-semibold text-foreground whitespace-nowrap"
            >Worked for {{ durationLabel() }}</span
          >
          <span class="cw-pill-meta text-[0.75rem] whitespace-nowrap">
            {{ expanded() ? 'Hide activity' : 'Show activity' }}
          </span>
          <span
            class="px-[0.4rem] py-0.5 rounded-full bg-foreground/6 text-[0.6875rem] tracking-[0.01em] whitespace-nowrap"
          >
            {{ stepCount() }} step{{ stepCount() === 1 ? '' : 's' }}
          </span>
          @if (agentSummary(); as summary) {
            <span
              class="px-[0.4rem] py-0.5 rounded-full bg-foreground/6 text-[0.6875rem] tracking-[0.01em] whitespace-nowrap"
            >
              {{ summary.agents.length }} agent{{ summary.agents.length === 1 ? '' : 's' }}
            </span>
          }
        </span>
        <span class="flex-1 min-w-6 h-px cw-turn-line"></span>
      </button>

      @if (changeDetails(); as details) {
        <div class="flex justify-center -mt-[0.2rem]">
          <button
            type="button"
            class="cw-turn-gap__changes cw-turn-gap__changes-button inline-flex items-center gap-[0.55rem] min-h-[1.8rem] px-[0.7rem] py-1 border border-border/86 rounded-full bg-background/74 text-foreground font-[inherit] cursor-pointer shadow-[0_8px_20px_-18px_color-mix(in_oklab,var(--foreground)_35%,transparent)] transition-[border-color,background-color,box-shadow] duration-[130ms] ease-in-out hover:border-primary/34 hover:bg-primary/7 hover:shadow-[0_10px_24px_-18px_color-mix(in_oklab,var(--primary)_40%,transparent)] focus-visible:outline-none focus-visible:border-primary/34 focus-visible:bg-primary/7"
            [attr.aria-expanded]="changesExpanded()"
            (click)="toggleChanges.emit()"
          >
            <span class="text-[0.74rem] font-[650]">
              {{ changesExpanded() ? 'Hide changes' : 'View changes' }}
            </span>
            <span
              class="inline-flex items-baseline gap-1 text-muted-foreground text-[0.68rem] font-semibold whitespace-nowrap"
            >
              {{ details.files }} file{{ details.files === 1 ? '' : 's' }}
              <span class="text-[color-mix(in_oklab,var(--success)_82%,var(--foreground))]"
                >+{{ details.additions }}</span
              >
              <span class="text-[color-mix(in_oklab,var(--destructive)_78%,var(--foreground))]"
                >-{{ details.deletions }}</span
              >
            </span>
          </button>
        </div>
      }

      @if (agentSummary(); as summary) {
        <div
          class="flex flex-col gap-2 mx-auto w-full px-[0.875rem] py-[0.625rem] border border-[color-mix(in_oklab,var(--primary)_20%,var(--border))] rounded-xl cw-agents-bg"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[0.75rem] font-semibold text-foreground">
              {{
                summary.agents.length === 1 ? '1 agent ran' : summary.agents.length + ' agents ran'
              }}
            </span>
            <button
              type="button"
              class="cw-turn-gap__inspect inline-flex items-center gap-1.5 px-3 py-[0.3rem] rounded-full border border-primary/38 bg-primary/9 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))] text-[0.75rem] font-semibold cursor-pointer whitespace-nowrap transition-[background,border-color] duration-[120ms] hover:bg-primary/15 hover:border-primary/55 focus-visible:outline-none"
              (click)="inspect.emit()"
            >
              Deep Dive →
            </button>
          </div>
          <div class="flex flex-col gap-1.5">
            @for (agent of summary.agents; track agent.agentId) {
              <button
                type="button"
                class="flex items-center gap-2 min-w-0 w-full rounded-lg border border-border/80 bg-background/70 px-[0.625rem] py-[0.4rem] text-foreground cursor-pointer text-left transition-[background,border-color] duration-100 hover:bg-primary/6 hover:border-primary/28 focus-visible:outline-none"
                [attr.data-state]="agent.status"
                (click)="inspect.emit()"
              >
                <span
                  class="w-[0.4375rem] h-[0.4375rem] rounded-full shrink-0 bg-muted-foreground data-[state=started]:bg-primary data-[state=started]:shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_25%,transparent)] data-[state=stopped]:bg-[color-mix(in_oklab,var(--success)_88%,var(--foreground))]"
                  [attr.data-state]="agent.status"
                ></span>
                <span class="text-[0.8125rem] font-semibold capitalize shrink-0">{{
                  agent.agentType
                }}</span>
                @if (agent.summary) {
                  <span
                    class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] text-muted-foreground"
                    >{{ agent.summary }}</span
                  >
                }
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      /* Sized against the pill's own width so the band reads the same in the
         session workspace and in the narrower review dock. */
      :host {
        display: block;
        container-type: inline-size;
        container-name: cw-turn-summary;
      }

      /* Multi-stop gradients — not expressible as single Tailwind utilities. */
      .cw-turn-line {
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in oklab, var(--border) 95%, transparent) 18%,
          color-mix(in oklab, var(--border) 95%, transparent) 82%,
          transparent
        );
      }

      .cw-pill-bg {
        background: linear-gradient(
          180deg,
          color-mix(in oklab, var(--card) 96%, var(--surface-tint) 4%),
          color-mix(in oklab, var(--card) 92%, var(--background))
        );
      }

      /* Top highlight plus a soft drop shadow. Both endpoints come from the
         surface tokens so the pill does not glow white in dark mode. */
      .cw-pill-shadow {
        box-shadow:
          inset 0 1px 0 color-mix(in oklab, var(--surface-tint) 55%, transparent),
          0 10px 24px -18px color-mix(in oklab, var(--foreground) 22%, transparent);
      }

      .cw-agents-bg {
        background:
          radial-gradient(
            circle at top right,
            color-mix(in oklab, var(--primary) 6%, transparent),
            transparent 55%
          ),
          color-mix(in oklab, var(--card) 95%, transparent);
      }

      @container cw-turn-summary (max-width: 44rem) {
        .cw-pill-meta {
          display: none;
        }
      }
    `,
  ],
})
export class ClaudeTurnSummaryComponent {
  readonly durationLabel = input.required<string>();
  readonly stepCount = input.required<number>();
  readonly agentSummary = input<TurnAgentSummary | null>(null);
  readonly changeDetails = input<TurnChangeDetails | null>(null);
  readonly expanded = input(false);
  readonly changesExpanded = input(false);

  readonly toggle = output<void>();
  readonly toggleChanges = output<void>();
  readonly inspect = output<void>();
}
