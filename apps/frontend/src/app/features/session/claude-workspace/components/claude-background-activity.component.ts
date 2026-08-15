import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBot, lucideChevronDown, lucideLayers } from '@ng-icons/lucide';
import { ClaudeBackgroundWorkItem } from '@/shared/models/claude-runtime.model';

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
  template: `
    @if (items().length) {
      <section class="cw-bga" role="status" aria-live="polite">
        <button
          type="button"
          class="cw-bga__head"
          [attr.aria-expanded]="expanded()"
          (click)="expanded.set(!expanded())"
        >
          <span class="cw-bga__orb" aria-hidden="true">
            <span class="cw-bga__orb-ring"></span>
            <span class="cw-bga__orb-core"></span>
          </span>

          <span class="cw-bga__title">
            {{ summaryLabel() }}
          </span>

          <span class="cw-bga__elapsed">{{ elapsedLabel() }}</span>

          <ng-icon
            name="lucideChevronDown"
            size="14"
            class="cw-bga__caret"
            [class.cw-bga__caret--open]="expanded()"
          />
        </button>

        @if (expanded()) {
          <ul class="cw-bga__list">
            @for (item of items(); track item.id) {
              <li class="cw-bga__item">
                <ng-icon
                  [name]="item.kind === 'subagent' ? 'lucideBot' : 'lucideLayers'"
                  size="13"
                  class="cw-bga__item-icon"
                />
                <span class="cw-bga__item-body">
                  <span class="cw-bga__item-label">{{ item.label }}</span>
                  @if (item.detail) {
                    <span class="cw-bga__item-detail">{{ item.detail }}</span>
                  }
                </span>
                <span class="cw-bga__item-elapsed">{{ elapsedFor(item) }}</span>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .cw-bga {
        border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border));
        border-radius: 0.625rem;
        background:
          linear-gradient(
            110deg,
            color-mix(in oklch, var(--primary) 7%, var(--card)),
            var(--card) 62%
          );
        overflow: hidden;
      }

      .cw-bga__head {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4rem 0.6rem;
        background: transparent;
        border: 0;
        cursor: pointer;
        text-align: left;
        color: var(--foreground);
        font-size: 0.75rem;
      }

      .cw-bga__head:hover {
        background: color-mix(in oklch, var(--primary) 8%, transparent);
      }

      .cw-bga__head:focus-visible {
        outline: 2px solid var(--ring);
        outline-offset: -2px;
      }

      /* Pulsing orb — reads as "something is alive over here" without the
         visual weight of a full spinner, which is reserved for the active turn. */
      .cw-bga__orb {
        position: relative;
        display: inline-flex;
        width: 0.9rem;
        height: 0.9rem;
        flex: none;
        align-items: center;
        justify-content: center;
      }

      .cw-bga__orb-core {
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 999px;
        background: var(--primary);
      }

      .cw-bga__orb-ring {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        border: 1px solid var(--primary);
        animation: cw-bga-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
      }

      @keyframes cw-bga-ping {
        0% {
          transform: scale(0.5);
          opacity: 0.9;
        }
        80%,
        100% {
          transform: scale(1.15);
          opacity: 0;
        }
      }

      .cw-bga__title {
        flex: 1 1 auto;
        min-width: 0;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cw-bga__elapsed {
        flex: none;
        color: var(--muted-foreground);
        font-variant-numeric: tabular-nums;
      }

      .cw-bga__caret {
        flex: none;
        color: var(--muted-foreground);
        transition: transform 150ms ease;
      }

      .cw-bga__caret--open {
        transform: rotate(180deg);
      }

      .cw-bga__list {
        margin: 0;
        padding: 0.15rem 0.6rem 0.45rem;
        list-style: none;
        border-top: 1px solid
          color-mix(in oklch, var(--primary) 18%, var(--border));
      }

      .cw-bga__item {
        display: flex;
        align-items: flex-start;
        gap: 0.45rem;
        padding: 0.28rem 0;
        font-size: 0.72rem;
      }

      .cw-bga__item-icon {
        flex: none;
        margin-top: 0.1rem;
        color: var(--primary);
      }

      .cw-bga__item-body {
        display: flex;
        flex-direction: column;
        gap: 0.05rem;
        flex: 1 1 auto;
        min-width: 0;
      }

      .cw-bga__item-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cw-bga__item-detail {
        color: var(--muted-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cw-bga__item-elapsed {
        flex: none;
        color: var(--muted-foreground);
        font-variant-numeric: tabular-nums;
      }

      @media (prefers-reduced-motion: reduce) {
        .cw-bga__orb-ring {
          animation: none;
          opacity: 0.5;
        }
      }
    `,
  ],
})
export class ClaudeBackgroundActivityComponent {
  readonly items = input.required<ClaudeBackgroundWorkItem[]>();

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

  elapsedFor(item: ClaudeBackgroundWorkItem): string {
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
